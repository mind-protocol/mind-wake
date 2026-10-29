import { spawnSync } from "node:child_process";

/** Verifies publisher signature on the build PC; does not claim acceptance by a recipient's policy. */
export function verifyPublisherSignature(binary) {
  // Node may inherit PowerShell 7's module path. Windows PowerShell must load its own
  // built-in Security/Utility modules, not incompatible PowerShell 7 assemblies.
  const env = { ...process.env, WAKE_SIGNED_FILE: binary };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
  const verification = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      '$ErrorActionPreference="Stop"; $s=Get-AuthenticodeSignature -LiteralPath $env:WAKE_SIGNED_FILE; @{status=$s.Status.ToString();publisher=$s.SignerCertificate.Subject;thumbprint=$s.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress',
    ],
    { env, encoding: "utf8", windowsHide: true, timeout: 30000 },
  );
  if (verification.error || verification.status !== 0)
    throw Error("Signature verification unavailable");
  const signature = JSON.parse(verification.stdout.replace(/^\uFEFF/, "").trim());
  if (signature.status !== "Valid" || !signature.thumbprint)
    throw Error("A valid publisher signature is required");
  return signature;
}
