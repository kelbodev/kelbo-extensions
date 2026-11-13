# Changelog

All notable changes to the `kubectl` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `kubectl@<version>`.

## [Unreleased]

## [1.0.0] - 2026-11-13

### Added
- **Kubernetes section** (Kelbo 2.34) with the `kubectl` of the machine (or `KELBO_KUBECTL`), run without a shell, always with `--context` and `-n` explicit; contexts from the user's kubeconfig (never copied), the current one marked; namespaces per context, the last one used remembered per context in this browser.
- **Pods**: status as `kubectl get pods` shows it (Running, CrashLoopBackOff, Completed, Terminating…), ready containers, restarts, age, node, owner deployment; filter by name, status, node or `label=value`; **live** updates from `kubectl get pods -w -o json --output-watch-events` (added, changed and removed pods, the changed rows highlighted).
- **On a pod**: describe (events included), **logs** in the bottom panel (container, last lines, follow, previous run), delete. **Workloads**: deployments and stateful sets with ready replicas, rollout restart and scale.
- **Confirmation for every change**; a context marked **protected** (🔒 in the sidebar, e.g. production; saved in `config.json`, *Export* checkbox) asks to type its name, checked by the server too.
- **Kubernetes port-forward** as a tunnel transport of the Tunnels section (`tunnel-transport`): context → namespace → service, deployment, stateful set or pod → port, chosen from the live lists; ready when kubectl prints *Forwarding from*; a pod replaced by its deployment is followed by forwarding to the deployment. *Port-forward…* on a pod opens the Tunnels form already filled in, with the pod's deployment when it has one.
- **MCP tools** (read-only): `kubectl_contexts`, `kubectl_namespaces`, `kubectl_pods` (without labels, environment or secrets), `kubectl_logs` (at most 1000 lines).
