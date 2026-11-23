# mend

One patch tool for every AI edit format: it applies an edit an AI model wrote
to a tree of text files, in four formats — unified diff, SEARCH/REPLACE
blocks, V4A patches, and JSON edits — with three-tier line matching
(exact, trailing-whitespace, full-whitespace), all-or-nothing writes, and
the exact output and exit-code rules of `SPEC.md`.

## Run

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is the patch file (or `-`, or absent, for standard input).
`--format` is `auto` (default), `unified`, `search-replace`, `v4a` or `json`.
`--check` reports what would change without writing anything.
`--strict` matches lines exactly (tier 0 only).

Node 22, standard library only. `runner.ts` is the trial handover used by
the make.fun harness; `practice.mjs` runs the public practice set locally.
