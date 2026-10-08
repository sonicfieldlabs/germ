# Durable local generation admission and recovery

The owner-only job journal is committed before dispatch or acknowledgement. A caller `request_id` binds the normalized generation request and workspace generation. An identical retry returns the retained job; a changed request or generation conflicts. Workspace render assigns one stable child request identity per selected source.

`GET /jobs/requests/{request_id}` finds a retained direct request or up to four render children. It rechecks current memory permissions and workspace binding; absence does not authorize replay. The coordinator records request identity before dispatch and can look it up after a lost acknowledgement.

The SQLite journal and process writer lease live under the configured isolated output root. One process owns the journal. On restart, queued/admitted/running/cancellation-requested work is interrupted or execution-unknown, never resubmitted. Committed terminal results and artifact pointers survive. Legacy terminal lifecycle receipts remain readable with explicitly unrecorded admission provenance. Journal capacity is bounded to 10,000 rows, 256 KiB per row and 256 MiB database; exhaustion refuses admission and requires an explicit retention decision. The journal stores private request context and must remain owner-only.

Queue capacity is released when a worker exits even if settlement recording fails. That failure is counted and the durable state remains unknown; acknowledgement, worker exit, receipt writing, and audio qualification are different facts.

Provider defaults belong to their runtime: MLX uses `sm-sfx`; the Python provider uses `small-sfx`. Explicit caller model names are preserved and unsupported names remain actionable refusals. Existing models are reused; these repairs do not download or activate a new model.
