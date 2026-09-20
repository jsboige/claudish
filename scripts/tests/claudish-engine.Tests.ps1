<#
    Pester 5 suite for scripts/lib/claudish-engine.psm1.

    Run:  pwsh -NoProfile -Command "Invoke-Pester ./scripts/tests -Output Detailed"

    These tests exist because the 2026-09-20 engine-recovery attempt shipped to
    the production hub with no way to exercise its logic except a real wedge.
    Every branch that mattered was reachable only in prod, so the one that threw
    was found by the host losing its container engine.

    The suite is deliberately heavy on REGRESSION tests, each named after the
    specific way a real instrument lied that day. A test named after a defect is
    worth more than a test named after a function.
#>

# A stand-in for the exception .NET raises on an HTTP error status: the thing
# that distinguishes "the server answered, with a status we did not want" from
# "nothing answered" is that the exception CARRIES a response object. Fabricating
# a real HttpWebResponse is not possible from script, and the property is all
# Test-HttpAlive looks at.
class ResponseBearingException : System.Exception {
    [object]$Response
    ResponseBearingException([string]$message, [object]$response) : base($message) {
        $this.Response = $response
    }
}

BeforeAll {
    $script:ModulePath = Join-Path $PSScriptRoot '..\lib\claudish-engine.psm1'
    Import-Module $script:ModulePath -Force
    $script:ScriptsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

    # Scripts a scheduled task runs unattended. Production invokes these with
    # `powershell` (Windows PowerShell 5.1), so they must parse there.
    $script:ScheduledTaskScripts = @(
        'claudish-watchdog.ps1',
        'claudish-drain.ps1',
        'lib\claudish-engine.psm1'
    )

    # Files that deliberately use pwsh-7-only syntax. Interactive analysis
    # tools only — never a scheduled task. Kept honest by a test below.
    $script:Pwsh7OnlyScripts = @('CaptureUtils.psm1')
}

Describe 'Get-ClaudishServingBase' {
    It 'returns $null when no base-url.txt exists (the fleet-wide default)' {
        Get-ClaudishServingBase -ClaudishHome $TestDrive | Should -BeNullOrEmpty
    }

    It 'returns $null for an empty file rather than an empty URL' {
        Set-Content -Path (Join-Path $TestDrive 'base-url.txt') -Value '' -NoNewline
        Get-ClaudishServingBase -ClaudishHome $TestDrive | Should -BeNullOrEmpty
    }

    It 'returns $null for content that is not an http(s) URL' {
        Set-Content -Path (Join-Path $TestDrive 'base-url.txt') -Value 'not-a-url'
        Get-ClaudishServingBase -ClaudishHome $TestDrive | Should -BeNullOrEmpty
    }

    It 'reads a valid URL and strips the trailing slash' {
        Set-Content -Path (Join-Path $TestDrive 'base-url.txt') -Value "http://192.168.0.50:3000/`n"
        Get-ClaudishServingBase -ClaudishHome $TestDrive | Should -Be 'http://192.168.0.50:3000'
    }

    It 'takes only the first line of a multi-line file' {
        Set-Content -Path (Join-Path $TestDrive 'base-url.txt') -Value "http://192.168.0.50:3000`n# a comment someone added"
        Get-ClaudishServingBase -ClaudishHome $TestDrive | Should -Be 'http://192.168.0.50:3000'
    }
}

Describe 'Resolve-ClaudishProbeUrl' {
    It 'falls back to localhost when nothing is configured (zero change by default)' {
        Resolve-ClaudishProbeUrl -ClaudishHome $TestDrive -Port 3000 | Should -Be 'http://localhost:3000'
    }

    It 'uses the configured host when base-url.txt is present' {
        Set-Content -Path (Join-Path $TestDrive 'base-url.txt') -Value 'http://192.168.0.50:3000'
        Resolve-ClaudishProbeUrl -ClaudishHome $TestDrive -Port 3000 | Should -Be 'http://192.168.0.50:3000'
    }

    It 'REGRESSION (#110): takes the PORT from the caller, never from the override' {
        # A machine-wide base URL carrying :3000 must not make a sidecar on
        # :3002 probe the hub's port. Resolving a URL once, globally, is what
        # made a dot-sourced drain probe the wrong container on ai-01.
        Set-Content -Path (Join-Path $TestDrive 'base-url.txt') -Value 'http://192.168.0.50:3000'
        Resolve-ClaudishProbeUrl -ClaudishHome $TestDrive -Port 3002 | Should -Be 'http://192.168.0.50:3002'
    }
}

Describe 'Get-LoopbackProbeUrl' {
    It 'REGRESSION: names [::1] explicitly and never localhost' {
        # A localhost probe from pwsh 7 falls back IPv6 -> IPv4 fast enough to
        # answer 200 over 127.0.0.1 while ::1 is dead — blind to the exact
        # outage the probe exists to catch.
        $url = Get-LoopbackProbeUrl -Port 3000
        $url | Should -Be 'http://[::1]:3000'
        $url | Should -Not -Match 'localhost'
    }
}

Describe 'Test-LoopbackListener' {
    It 'is $true when the enumerator sees a [::1] listener' {
        Test-LoopbackListener -Port 3000 -Enumerator { param($p) @([PSCustomObject]@{ LocalAddress = '::1' }) } | Should -BeTrue
    }

    It 'is $false when nothing is listening on [::1]' {
        Test-LoopbackListener -Port 3000 -Enumerator { param($p) @() } | Should -BeFalse
    }

    It 'REGRESSION (mirrored trap): an enumerator that THROWS yields $false, not a verdict' {
        # Under networkingMode=mirrored the Windows TCP table cannot enumerate
        # the mirrored netns. "Not visible" must never be read as "not serving":
        # that misreading is what produced a published-then-retracted verdict.
        Test-LoopbackListener -Port 3000 -Enumerator { param($p) throw 'table not enumerable' } | Should -BeFalse
    }
}

Describe 'Test-HttpAlive' {
    It 'is $true on a clean response' {
        Test-HttpAlive -Url 'http://x/health' -Requester { param($u, $t) } | Should -BeTrue
    }

    It 'REGRESSION (5.1): an HTTP 400 counts as ALIVE, not as a wedge' {
        # Measured on the hub: Windows PowerShell 5.1 gets HTTP 400 from
        # http://[::1]:3000/health at the same moment pwsh 7 gets 200 from the
        # same address. A 400 is proof the forwarder carried the request and
        # brought an answer back. Requiring 200 turned a healthy machine into a
        # phantom wedge under the production interpreter — a defect that no
        # amount of testing under pwsh 7 could have found.
        #
        # The distinguishing fact is that the exception CARRIES a response
        # object, which is what both interpreters do on an HTTP error status.
        Test-HttpAlive -Url 'http://x/health' -Requester {
            param($u, $t)
            throw [ResponseBearingException]::new('(400) Bad Request', 'an HttpWebResponse')
        } | Should -BeTrue
    }

    It 'is $false only when NO response object came back (transport failure)' {
        Test-HttpAlive -Url 'http://x/health' -Requester { param($u, $t) throw 'connection refused' } |
            Should -BeFalse
    }
}

Describe 'Test-EngineRecoveryOptIn' {
    It 'is $false on a machine with no opt-in file (the default everywhere)' {
        Test-EngineRecoveryOptIn -ClaudishHome $TestDrive | Should -BeFalse
    }

    It 'REGRESSION: an EMPTY opt-in file does not arm a teardown' {
        # The previous guard armed on an accidental condition. An accidental
        # `New-Item` or stray redirect must not enable tearing down the host's
        # container engine.
        Set-Content -Path (Join-Path $TestDrive (Get-ClaudishOptInFileName)) -Value '' -NoNewline
        Test-EngineRecoveryOptIn -ClaudishHome $TestDrive | Should -BeFalse
    }

    It 'is $false when the file exists with the wrong content' {
        Set-Content -Path (Join-Path $TestDrive (Get-ClaudishOptInFileName)) -Value 'yes please'
        Test-EngineRecoveryOptIn -ClaudishHome $TestDrive | Should -BeFalse
    }

    It 'is $true only for the exact token, whitespace-tolerant' {
        Set-Content -Path (Join-Path $TestDrive (Get-ClaudishOptInFileName)) -Value "  $(Get-ClaudishOptInToken)  `n"
        Test-EngineRecoveryOptIn -ClaudishHome $TestDrive | Should -BeTrue
    }
}

Describe 'ConvertFrom-QuserOutput / Get-InteractiveUserId' {
    It 'REGRESSION (locale): parses the FRENCH quser output captured on the hub' {
        # Verbatim from po-2025, 2026-09-20. A parser keying on the word
        # "Active" finds nobody here — the headers and the state column are
        # localized. Only the session-name column ("console", "rdp-tcp#N") is
        # a stable literal.
        $fr = @"
 UTILISATEUR           SESSION            ID  ÉTAT    TEMPS INACT TEMPS SESSION
>jsboi                 rdp-tcp#1           2  Actif           2  20/09/2026 12:27
"@
        ConvertFrom-QuserOutput -QuserText $fr | Should -Be 'jsboi'
    }

    It 'parses English console output too' {
        $en = @"
 USERNAME              SESSIONNAME        ID  STATE   IDLE TIME  LOGON TIME
 operator              console             1  Active      none   9/20/2026 8:02 AM
"@
        ConvertFrom-QuserOutput -QuserText $en | Should -Be 'operator'
    }

    It 'returns $null on empty or header-only output' {
        ConvertFrom-QuserOutput -QuserText '' | Should -BeNullOrEmpty
        ConvertFrom-QuserOutput -QuserText 'No User exists for *' | Should -BeNullOrEmpty
    }

    It 'REGRESSION (RDP): falls through an EMPTY Win32_ComputerSystem.UserName to quser' {
        # Measured on the hub: that property reports the CONSOLE session only,
        # and the operator is on RDP, so it comes back empty. Believing it
        # would make the preflight fail forever and the recovery path dead code
        # on the one machine it was written for.
        $id = Get-InteractiveUserId -Probe { '' } -QuserProbe {
            " UTILISATEUR   SESSION      ID  ÉTAT`n>jsboi         rdp-tcp#1     2  Actif"
        }
        $id | Should -Be ("{0}\jsboi" -f $env:COMPUTERNAME)
    }

    It 'prefers the console-session answer when it is available' {
        Get-InteractiveUserId -Probe { 'MACHINE\someone' } -QuserProbe { 'should not be reached' } |
            Should -Be 'MACHINE\someone'
    }

    It 'falls all the way through to the process-owner probe' {
        Get-InteractiveUserId -Probe { '' } -QuserProbe { '' } -ProcessOwnerProbe { 'MACHINE\viaexplorer' } |
            Should -Be 'MACHINE\viaexplorer'
    }

    It 'returns $null when every probe fails or throws (fail-safe)' {
        Get-InteractiveUserId -Probe { throw 'wmi down' } -QuserProbe { throw 'no quser' } -ProcessOwnerProbe { throw 'denied' } |
            Should -BeNullOrEmpty
    }
}

Describe 'Test-EngineRelaunchReady (the no-teardown-without-a-proven-rebuild gate)' {
    BeforeAll {
        $script:okPath  = { param($p) $true }
        $script:okUser  = { 'MACHINE\operator' }   # a full resolver, not one probe
        $script:okReg   = { param($n, $exe, $u) }
        $script:okVerif = { param($n) $true }
    }

    It 'is Ready when every stage succeeds' {
        $r = Test-EngineRelaunchReady -TaskName 'T' -PathTest $okPath -UserResolver $okUser -Registrar $okReg -Verifier $okVerif
        $r.Ready | Should -BeTrue
        $r.Checks | Should -Contain 'register:OK'
        $r.Checks | Should -Contain 'verify:OK'
    }

    It 'refuses when the executable is missing' {
        $r = Test-EngineRelaunchReady -TaskName 'T' -PathTest { param($p) $false } -UserResolver $okUser -Registrar $okReg -Verifier $okVerif
        $r.Ready | Should -BeFalse
        $r.Reason | Should -Match 'executable'
    }

    It 'refuses when no interactive user can be resolved' {
        $r = Test-EngineRelaunchReady -TaskName 'T' -PathTest $okPath -UserResolver { $null } -Registrar $okReg -Verifier $okVerif
        $r.Ready | Should -BeFalse
        $r.Reason | Should -Match 'user'
    }

    It 'REGRESSION (13:18): a registration that THROWS yields Ready=$false, not an assumption' {
        # This is the exact failure that cost the host its engine:
        #   "Register-ScheduledTask: cannot find a parameter named LogonType"
        # thrown AFTER the teardown. Here it is thrown BEFORE, and it is fatal
        # to the decision instead of fatal to the machine.
        $r = Test-EngineRelaunchReady -TaskName 'T' -PathTest $okPath -UserResolver $okUser `
            -Registrar { param($n, $exe, $u) throw 'Cannot find a parameter named LogonType' } -Verifier $okVerif
        $r.Ready | Should -BeFalse
        $r.Checks | Should -Contain 'register:FAILED'
        $r.Reason | Should -Match 'LogonType'
    }

    It 'REGRESSION: a NON-TERMINATING registration error is not read as success' {
        # Found by running the preflight for real, unelevated, on the hub:
        # Register-ScheduledTask emits "Access denied" as a non-terminating
        # error, so the enclosing try/catch never fired and the preflight
        # recorded register:OK for a task that was never created. Only the
        # read-back caught it. A gate must not depend on its own backstop.
        $r = Test-EngineRelaunchReady -TaskName 'T' -PathTest $okPath -UserResolver $okUser `
            -Registrar { param($n, $exe, $u) Write-Error 'Access denied.' } -Verifier $okVerif
        $r.Ready | Should -BeFalse
        $r.Checks | Should -Contain 'register:FAILED'
        $r.Checks | Should -Not -Contain 'register:OK'
    }

    It 'refuses when the task cannot be read back after a "successful" registration' {
        $r = Test-EngineRelaunchReady -TaskName 'T' -PathTest $okPath -UserResolver $okUser -Registrar $okReg -Verifier { param($n) $false }
        $r.Ready | Should -BeFalse
        $r.Checks | Should -Contain 'verify:ABSENT'
    }

    It 'treats an exception from the verifier as not-ready' {
        $r = Test-EngineRelaunchReady -TaskName 'T' -PathTest $okPath -UserResolver $okUser -Registrar $okReg -Verifier { param($n) throw 'rpc down' }
        $r.Ready | Should -BeFalse
    }
}

Describe 'New-EngineRelaunchRegistration (cmdlet surface)' {
    It 'REGRESSION: Register-ScheduledTask has no -LogonType parameter' {
        # The fact the code on main got wrong, pinned directly against the
        # installed cmdlet rather than against a memory of it.
        (Get-Command Register-ScheduledTask).Parameters.Keys | Should -Not -Contain 'LogonType'
        (Get-Command Register-ScheduledTask).Parameters.Keys | Should -Contain 'Principal'
    }

    It 'builds an Interactive principal without admin rights (the corrected shape)' {
        $p = New-ScheduledTaskPrincipal -UserId 'MACHINE\operator' -LogonType Interactive -RunLevel Highest
        $p.LogonType | Should -Be 'Interactive'
    }
}

Describe 'Get-WedgeDecision (pure decision table)' {
    It 'does nothing when the serving path itself is unhealthy' {
        $d = Get-WedgeDecision -ServingHealthy $false -LoopbackListening $true -LoopbackHealthy $false -ConsecutiveWedge 5
        $d.Action | Should -Be 'none'
        $d.Reason | Should -Match 'hang path'
    }

    It 'does nothing when no [::1] listener is visible (fail-safe under mirrored)' {
        $d = Get-WedgeDecision -ServingHealthy $true -LoopbackListening $false -LoopbackHealthy $false -ConsecutiveWedge 5
        $d.Action | Should -Be 'none'
    }

    It 'does nothing and resets when the loopback is healthy' {
        $d = Get-WedgeDecision -ServingHealthy $true -LoopbackListening $true -LoopbackHealthy $true -ConsecutiveWedge 1
        $d.Action | Should -Be 'none'
        $d.Wedge | Should -Be 0
    }

    It 'arms on the first sighting without acting (1 of 2)' {
        $d = Get-WedgeDecision -ServingHealthy $true -LoopbackListening $true -LoopbackHealthy $false -ConsecutiveWedge 0
        $d.Action | Should -Be 'arm'
        $d.Wedge | Should -Be 1
    }

    It 'DEFAULT: a confirmed wedge on a non-opted-in machine only escalates' {
        # No machine acts on its engine merely because the code shipped there.
        $d = Get-WedgeDecision -ServingHealthy $true -LoopbackListening $true -LoopbackHealthy $false -ConsecutiveWedge 1
        $d.Action | Should -Be 'escalate'
        $d.Reason | Should -Match 'NOT opted in'
    }

    It 'CORE GUARD: opted in but no proven rebuild path still refuses to act' {
        $d = Get-WedgeDecision -ServingHealthy $true -LoopbackListening $true -LoopbackHealthy $false `
            -ConsecutiveWedge 1 -OptIn $true -RelaunchReady $false
        $d.Action | Should -Be 'escalate'
        $d.Reason | Should -Match 'refusing to tear down'
    }

    It 'respects the rate limit once everything else is satisfied' {
        $now = [datetime]'2026-09-20T13:00:00Z'
        $d = Get-WedgeDecision -ServingHealthy $true -LoopbackListening $true -LoopbackHealthy $false `
            -ConsecutiveWedge 1 -OptIn $true -RelaunchReady $true -Now $now -LastRecoveryUtc $now.AddHours(-1) -RateLimitHours 6
        $d.Action | Should -Be 'escalate'
        $d.Reason | Should -Match 'rate-limited'
    }

    It 'recovers only when confirmed AND opted in AND proven AND outside the rate limit' {
        $now = [datetime]'2026-09-20T13:00:00Z'
        $d = Get-WedgeDecision -ServingHealthy $true -LoopbackListening $true -LoopbackHealthy $false `
            -ConsecutiveWedge 1 -OptIn $true -RelaunchReady $true -Now $now -LastRecoveryUtc $now.AddHours(-7) -RateLimitHours 6
        $d.Action | Should -Be 'recover'
    }

    It 'recovers when there is no prior recovery on record' {
        $d = Get-WedgeDecision -ServingHealthy $true -LoopbackListening $true -LoopbackHealthy $false `
            -ConsecutiveWedge 1 -OptIn $true -RelaunchReady $true
        $d.Action | Should -Be 'recover'
    }

    It 'REGRESSION: every verdict names which condition decided it' {
        # "HEALTH FAILED" with no discriminant is how "one probe of two is
        # dead" was published as "everything is dead".
        foreach ($case in @(
            @{ S = $false; L = $true;  H = $false; O = $false; R = $false }
            @{ S = $true;  L = $false; H = $false; O = $false; R = $false }
            @{ S = $true;  L = $true;  H = $true;  O = $false; R = $false }
            @{ S = $true;  L = $true;  H = $false; O = $false; R = $false }
            @{ S = $true;  L = $true;  H = $false; O = $true;  R = $false }
            @{ S = $true;  L = $true;  H = $false; O = $true;  R = $true  }
        )) {
            $d = Get-WedgeDecision -ServingHealthy $case.S -LoopbackListening $case.L -LoopbackHealthy $case.H `
                -ConsecutiveWedge 1 -OptIn $case.O -RelaunchReady $case.R
            $d.Reason | Should -Not -BeNullOrEmpty
            $d.Action | Should -BeIn @('none', 'arm', 'escalate', 'recover')
        }
    }
}

Describe 'Static guardrails over scripts/' {
    It 'REGRESSION: no script passes -LogonType to Register-ScheduledTask' {
        # Pins the defect tree-wide, not just in the module that fixed it.
        #
        # This walks the AST rather than grepping the text, deliberately. The
        # first draft of this test was a regex, and it reported three offenders:
        # the one real call plus this file and the module, which merely DISCUSS
        # the defect in prose. An instrument that cannot tell a call from a
        # comment about a call produces exactly the wrong-but-plausible number
        # this repo has been bitten by before (counting armed cascades by name,
        # reading an empty TCP table as a verdict). The AST sees commands.
        $offenders = @()
        Get-ChildItem -Path $script:ScriptsRoot -Filter '*.ps*1' -Recurse -File | ForEach-Object {
            $tokens = $null; $errs = $null
            $ast = [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errs)
            $calls = $ast.FindAll({
                param($n)
                $n -is [System.Management.Automation.Language.CommandAst] -and
                $n.GetCommandName() -eq 'Register-ScheduledTask'
            }, $true)
            foreach ($call in $calls) {
                $params = $call.CommandElements |
                    Where-Object { $_ -is [System.Management.Automation.Language.CommandParameterAst] } |
                    ForEach-Object { $_.ParameterName }
                if ($params -contains 'LogonType') { $offenders += ('{0}:{1}' -f $_.Name, $call.Extent.StartLineNumber) }
            }
        }
        $offenders | Should -BeNullOrEmpty
    }

    It 'the AST offender-detector actually detects (positive control)' {
        # A guard that matches nothing passes for the wrong reason. Same role as
        # the 24 controller.close() hits that prove the never-hang filter still
        # matches something.
        $tokens = $null; $errs = $null
        $bad = [System.Management.Automation.Language.Parser]::ParseInput(
            'Register-ScheduledTask -TaskName T -Action $a -User "x\y" -LogonType Interactive -Force',
            [ref]$tokens, [ref]$errs)
        $calls = $bad.FindAll({
            param($n)
            $n -is [System.Management.Automation.Language.CommandAst] -and
            $n.GetCommandName() -eq 'Register-ScheduledTask'
        }, $true)
        $calls.Count | Should -Be 1
        ($calls[0].CommandElements |
            Where-Object { $_ -is [System.Management.Automation.Language.CommandParameterAst] } |
            ForEach-Object { $_.ParameterName }) | Should -Contain 'LogonType'
    }

    It 'the watchdog gates engine recovery on the explicit opt-in helper, not on a string comparison' {
        $wd = Get-Content -LiteralPath (Join-Path $script:ScriptsRoot 'claudish-watchdog.ps1') -Raw
        if ($wd -match 'Get-WedgeDecision') {
            $wd | Should -Match 'Test-EngineRecoveryOptIn'
            $wd | Should -Match 'Test-EngineRelaunchReady'
        }
    }

    It 'REGRESSION (5.1): every scheduled-task script parses under THIS interpreter' {
        # The scheduled tasks invoke `powershell -ExecutionPolicy Bypass -File`,
        # which is Windows PowerShell 5.1 — NOT pwsh 7. A pwsh-7-only construct
        # (`??`, `?.`, ternary) in any of these files is a parse failure that
        # occurs only in production, on a machine nobody is watching, and takes
        # the watchdog out entirely. It is the same shape of defect as the
        # HTTP 400 one: correct under the interpreter used for development,
        # broken under the interpreter used for the job. Run this suite under
        # BOTH interpreters — under 5.1 it is the assertion that matters.
        $errors = @()
        foreach ($rel in $script:ScheduledTaskScripts) {
            $path = Join-Path $script:ScriptsRoot $rel
            $path | Should -Exist
            $e = $null; $t = $null
            [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$t, [ref]$e) | Out-Null
            if ($e -and $e.Count -gt 0) { $errors += ('{0}: {1}' -f $rel, $e[0].Message) }
        }
        $errors | Should -BeNullOrEmpty
    }

    It 'every other script in scripts/ parses, except the documented pwsh-7-only ones' {
        # CaptureUtils.psm1 uses `??` deliberately and its consumers are
        # documented as requiring pwsh ("traffic-anthropic.ps1 exige pwsh").
        # That is a supported choice for an interactive analysis tool, and a
        # different thing from an unattended scheduled task. The exclusion is
        # scoped to 5.1 only, so under pwsh 7 these files are still asserted —
        # an exclusion that hides a file from every interpreter hides a defect.
        $skip = if ($PSVersionTable.PSVersion.Major -lt 7) { $script:Pwsh7OnlyScripts } else { @() }
        $errors = @()
        Get-ChildItem -Path $script:ScriptsRoot -Filter '*.ps*1' -Recurse -File |
            Where-Object { $skip -notcontains $_.Name } | ForEach-Object {
                $e = $null; $t = $null
                [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$t, [ref]$e) | Out-Null
                if ($e -and $e.Count -gt 0) { $errors += ('{0}: {1}' -f $_.Name, $e[0].Message) }
            }
        $errors | Should -BeNullOrEmpty
    }

    It 'the pwsh-7-only list is accurate and not a dumping ground' {
        # A skip list nobody maintains grows until it covers the file that
        # actually broke. Under pwsh 7 every listed file must parse (proving the
        # entry is about interpreter version, not about a real syntax error),
        # and no scheduled-task script may ever appear on it.
        foreach ($name in $script:Pwsh7OnlyScripts) {
            $script:ScheduledTaskScripts | ForEach-Object { (Split-Path $_ -Leaf) | Should -Not -Be $name }
        }
        if ($PSVersionTable.PSVersion.Major -ge 7) {
            foreach ($name in $script:Pwsh7OnlyScripts) {
                $f = Get-ChildItem -Path $script:ScriptsRoot -Filter $name -Recurse -File | Select-Object -First 1
                $f | Should -Not -BeNullOrEmpty -Because "$name is listed as pwsh-7-only but does not exist"
                $e = $null; $t = $null
                [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$t, [ref]$e) | Out-Null
                $e | Should -BeNullOrEmpty -Because "$name must be valid pwsh 7, merely not 5.1"
            }
        }
    }
}
