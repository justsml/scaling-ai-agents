# Ground truth (for the reviewer worker's scoring; workers must not read this)

Two independent causes, not one:

1. **Network:** proxy idle timeout is 60s; app heartbeat defaults to 90s because `WS_HEARTBEAT_MS` is unset. Every idle connection is closed by the proxy before the first heartbeat. Fix: set heartbeat below 60s or raise proxy idle timeout. Evidence: network.log `idle_timeout(60s)`, app.log `heartbeat.interval_ms=90000`.
2. **State:** reconnect succeeds but subscriptions are not replayed. Evidence: state.json `restored_after_reconnect: []`, app.log `subscriptions_restored=false`.

A reviewer that accepts "proxy timeout" alone has missed the second cause. The favored hypothesis is correct but incomplete.
