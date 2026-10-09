# Generation lifecycle (G5)

GERM uses one bounded JobRunner for queued and synchronous provider calls, including
G1 linked generation. There is no second scheduler, model loader or MLX executor.
At most `job_workers` calls execute concurrently; admission capacity is eight times
that count, including running and queued work. Saturated requests receive HTTP 429;
closed admission receives 503. Existing provider-specific locks and timeouts still apply.

Use `/jobs/submit` for a job ID immediately. Its request accepts the existing generation
fields, including G6/G4 plan handoffs. At worker dispatch, derivations recheck current
source fingerprints, parent identity, declared permissions and the host parameter
policy. A record changed while queued is rejected before the provider starts.
Synchronous calls wait for the same runner and keep their existing response shape.

`GET /jobs/status` exposes admission state, worker count, capacity and outstanding work.
`GET /jobs/{id}` and its existing events WebSocket expose `metrics.execution_state`:
`admitted`, `running`, `cancellation_requested`, or `settled`. Admission failures use
`not_admitted`. The job's compatibility status can become `cancelled` immediately,
while execution state accurately records that its worker has not yet stopped.
The event stream waits for settlement and receipt handling before its final event.

`POST /jobs/{id}/cancel` atomically preserves a completed result if completion already
won. Otherwise it signals the existing provider cancellation event. Queued futures
can stop before invocation and release their slot; running work keeps its slot until
it settles. A late provider result cannot revive a cancelled job. Its status is retained
as `metrics.late_provider_status`, and any existing artifact paths remain available.
A cancellation observed before metadata commitment suppresses completed Akousma/MASA
companions. Cancellation after commitment does not erase actual output evidence.

The existing MLX subprocess path polls cancellation, stops its process group and
handles its configured timeout. These controls were exercised with real isolated
Python subprocesses, not loaded model weights. Other providers remain cooperative:
requesting cancellation does not guarantee interruption of a blocked native call or
reversal of a request already accepted by a remote service.

## Application shutdown and receipts

Application lifespan closes admission, cancels queued futures and signals active
workers. It allows a bounded worker drain (`GERM_WORKER_SHUTDOWN_SECONDS`, default 7, maximum
60 seconds) and records whether workers settled. It does not claim they stopped
immediately. Restarting the runner is refused
until previous workers have settled. Shipped launchers use a two-second HTTP shutdown
grace (`GERM_SHUTDOWN_GRACE_SECONDS`) so a blocked synchronous request cannot prevent
the lifespan hook from signalling workers. Export overrides to both server and native
supervisor; the supervisor allows time for that grace and drain before force termination.
A request interrupted by shutdown may lose its HTTP response or return 500; its job
receipt, when settled, remains the authoritative local outcome. Existing model/device controls remain in their
own providers. A process crash is not a successful shutdown receipt, and jobs are not
automatically resumed or retried.

Settled jobs and admission refusals write private `germ/job-lifecycle/v0.1` JSON receipts
under `output/job-receipts/`, using the existing atomic writer. They retain job/provider
identity, a request fingerprint, artifact pointers, status and bounded error text;
they do not duplicate source prose. `GET /jobs/{id}/receipt` can read a retained receipt
after its in-memory job entry is evicted or the app restarts. Receipt persistence errors
remain explicit in job metrics and do not discard generated audio. There is no automatic
receipt pruning in this revision; owner retention policy controls these local files.

Generation metadata also records lifecycle state at output commitment; the existing
MASA Generation receipt carries that state in `germ:lifecycle`. This snapshot is not
an assertion that subsequent cancellation or receipt persistence had already finished.
Lifecycle receipts attest to local execution state; their artifact pointers do not
certify audio integrity or remote cancellation. G3's separately verified output hash
and MASA receipt remain the output evidence.

Tests cover queue saturation, slot release, shutdown/restart, escaped worker failures,
late completion after cancellation, queued-source revocation, retained receipt access,
metadata commit boundaries and real MLX-path process termination/timeouts. No new UI,
production provider, physical device or independently heard output is claimed.
