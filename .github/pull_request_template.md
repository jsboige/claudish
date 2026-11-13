Lane: myia-<machine>:<lane>

<!-- La ligne Lane: est OBLIGATOIRE et doit rester en tête (décision #328 du
     13/11) : le login GitHub est partagé, une PR sans sa lane ne s'attribue
     à personne. -->

## Quoi / What

<!-- Un paragraphe : ce qui change, et pourquoi. Rien d'autre dans cette
     section. -->

## Preuve / Proof

<!-- Les trois portes, chacune avec le SHA sur lequel elle a tourné (protocole
     de review : une porte tournée sur un commit antérieur ne vaut pas pour
     la tête) :
     - tests concernés : `bun test <fichiers>` ; pour un script PowerShell,
       pwsh 7 ET Windows PowerShell 5.1 (`run-pester51.ps1`) ;
     - `bun run typecheck` ;
     - biome sur les fichiers touchés (version épinglée, jamais `bunx biome`
       flottant).
     Pour un geste conteneur/env : la relecture PAR VALEUR après le geste.
     Pour un chiffre ou un verdict : l'instrument et sa fenêtre. -->

## Mots-clés / Keywords

<!-- `Closes #NN` UNIQUEMENT si tous les critères de l'issue sont remplis ;
     sinon `Refs #NN`. Un merge ferme une issue par TROIS canaux (body,
     message de squash, closingIssuesReferences) : ne jamais écrire
     `Closes #NN` pour en PARLER. -->

Refs #
