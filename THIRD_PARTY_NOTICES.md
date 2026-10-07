# Third-Party Notices

## tt-a1i/archify (MIT)

This plugin is a transformation of the archify diagram skill
([tt-a1i/archify](https://github.com/tt-a1i/archify), MIT, and its official
DSH packaging `@tt-a1i/archify-dsh@0.1.0`, same-source port
[GongYuanCaiJi/dsh-archify](https://github.com/GongYuanCaiJi/dsh-archify)).

Retained from the base: the DSH plugin packaging shape (`package.json`
`dsh.bundle.patch` + `cordis.patch.yml` filesystem Skill provider +
`prepare` staging script) and the standalone-HTML viewer concept.

Replaced for the hardware-topology focus: the five generic diagram engines
(architecture/workflow/sequence/dataflow/lifecycle) gave way to a
scan→derive→verify→deliver pipeline with an evidence-first topology model,
a dependency-free RTL indexer, a per-element verification gate, and a wiki
codebase-index generator.

Original license text: see `LICENSE` (MIT, copyright tt-a1i and
contributors; Cocoon-AI/architecture-diagram-generator lineage per the
upstream SKILL.md metadata).
