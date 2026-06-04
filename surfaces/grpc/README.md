# @tenet/surface-grpc

gRPC surface — `.proto` service definition (`PROTO_SOURCE`) plus framework-agnostic `Converse` and `ConverseStream` handlers. No grpc-js / connect-rpc hard dep; apps wire the handlers into their preferred runtime.

```
service TenetAgent {
  rpc Converse(ConverseRequest) returns (ConverseResponse);
  rpc ConverseStream(ConverseRequest) returns (stream ConverseChunk);
}
```
