# TENET Helm chart

On-prem / self-host deploy. Apache-2.0 licensed.

```bash
helm install tenet ./infra/helm/tenet \
  --namespace tenet --create-namespace \
  --set image.tag=v0.0.0 \
  --set telemetry.otlp.endpoint=otel-collector.observability.svc.cluster.local:4317
```

Secrets are NEVER baked into the chart. Create a `tenet-secrets` secret first:

```bash
kubectl create secret generic tenet-secrets \
  --from-literal=anthropic-api-key=sk-ant-... \
  --from-literal=jwt-secret=$(openssl rand -base64 32) \
  --from-literal=database-url=postgres://...
```

Security defaults:
- `runAsNonRoot: true` (UID 10001)
- `readOnlyRootFilesystem: true`
- `allowPrivilegeEscalation: false`
- All Linux capabilities dropped
- Optional `networkPolicy` for egress restriction

Manifests covered:
- `Deployment` with security context + probes + secret-ref env
- `Service` (ClusterIP by default)
- `Ingress` (off by default; enable per environment)
- `HorizontalPodAutoscaler` (CPU-based)
- `NetworkPolicy` (off by default)
- `ServiceAccount`

Lint with `helm lint ./infra/helm/tenet`. Smoke-test render: `helm template ./infra/helm/tenet`.
