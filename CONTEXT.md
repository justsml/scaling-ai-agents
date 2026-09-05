# Agentic Parallelism Lab

This repository compares agentic execution patterns across independent stacks using the same worked examples.

## Language

**Readiness challenge**:
The complete flaky-integration problem package: buggy source, immutable tests, evaluation rubric, reference artifact, and certification behavior.
_Avoid_: Readiness fixture, fixture bundle

**Reference artifact**:
The known-good solution shipped with a challenge for use as a tournament control and deterministic fallback.
_Avoid_: Reference patch, golden patch

**Certified artifact**:
A challenge artifact that passes every deterministic fixture test. Rubric scoring ranks certified artifacts but does not determine certification.
_Avoid_: Winning patch, approved patch

**Pokédex investigation**:
A conformance scenario in which an agent answers a realistic research request by paging through Pokémon records, searching the result set, and following related records.
_Avoid_: PokéAPI benchmark, Pokémon lookup

**Conformance harness**:
The common agent-driven test system that runs comparable scenarios across the independent stacks and collects normalized evidence. It does not replace a stack's deterministic certification.
_Avoid_: Shared implementation, test agent

**Driver**:
The Pi-controlled actor that submits conformance scenarios to each stack and collects their evidence without solving the scenario itself.
_Avoid_: Test agent, evaluator model

**Stack agent**:
The framework-specific agent whose reasoning, tool use, and answer are evaluated during a conformance run.
_Avoid_: Driver, harness agent

**Pokédex tool contract**:
The common set of discovery, paging, search, and read operations available to every stack agent during a Pokédex investigation.
_Avoid_: PokéAPI client, shared tool implementation
