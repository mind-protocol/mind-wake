export async function result(operation) {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await operation()) }] };
  } catch (error) {
    const known = [
      "busy",
      "unauthorized",
      "forbidden",
      "unsafe_path",
      "unsupported_file",
      "file_limit",
      "hash_conflict",
      "idempotency_conflict",
      "invalid_request",
      "queue_limit",
      "unknown_proposal",
      "backup_mismatch",
      "changed_during_read",
      "deadline",
      "stopped",
      "sensitive_content",
      "unknown_operation",
      "scope_conflict",
    ];
    const code =
      error.code === "EEXIST"
        ? "busy"
        : known.includes(error.message)
          ? error.message
          : "operation_failed";
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code }) }] };
  }
}
