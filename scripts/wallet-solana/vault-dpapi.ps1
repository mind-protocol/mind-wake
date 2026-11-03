$ErrorActionPreference = 'Stop'
try {
  if ($Action -eq 'secure-home') {
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    [System.IO.Directory]::SetAccessControl($VaultPath, $acl)
    [Console]::Out.Write('ok')
  } elseif ($Action -eq 'check-home') {
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $acl = [System.IO.Directory]::GetAccessControl($VaultPath)
    if (-not $acl.AreAccessRulesProtected) { throw 'inheritance' }
    $objects = @($acl)
    $walletFile = [System.IO.Path]::Combine($VaultPath, 'wallet.json')
    if ([System.IO.File]::Exists($walletFile)) { $objects += [System.IO.File]::GetAccessControl($walletFile) }
    foreach ($object in $objects) {
      $rules = $object.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
      $hasOwner = $false
      foreach ($rule in $rules) {
        if ($rule.IdentityReference.Value -ne $sid -or $rule.AccessControlType -ne 'Allow') { throw 'unexpected principal' }
        if (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) { $hasOwner = $true }
      }
      if (-not $hasOwner) { throw 'missing owner' }
    }
    [Console]::Out.Write('ok')
  } elseif ($Action -eq 'protect' -or $Action -eq 'unprotect') {
    Add-Type -AssemblyName System.Security
    $stream = New-Object System.IO.MemoryStream
    [Console]::OpenStandardInput().CopyTo($stream)
    $bytes = $stream.ToArray()
    if ($bytes.Length -eq 0 -or $bytes.Length -gt 16384) { throw 'invalid size' }
    $entropy = [System.Text.Encoding]::UTF8.GetBytes('mind-wake.wallet-solana.v1')
    try {
      if ($Action -eq 'protect') {
        $result = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
      } else {
        $result = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
      }
      [Console]::OpenStandardOutput().Write($result, 0, $result.Length)
    } finally {
      [Array]::Clear($bytes, 0, $bytes.Length)
      if ($null -ne $result) { [Array]::Clear($result, 0, $result.Length) }
      $stream.Dispose()
    }
  } else { throw 'invalid operation' }
} catch {
  [Console]::Error.WriteLine('Protected vault operation failed.')
  exit 1
}
