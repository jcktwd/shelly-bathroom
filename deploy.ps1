<#
.SYNOPSIS
    Deploys mJS automation scripts to Shelly Gen 4 / Plus devices via local HTTP RPC.

.DESCRIPTION
    Handles chunked OTA code transfer to prevent web server buffer overflow, manages auto-restart 
    flags during flashing, and dynamically injects private LAN IPs from deploy.config.json.

.PARAMETER Target
    The automation target to deploy: 'central', 'mirror', or 'all'. Defaults to 'central'.

.PARAMETER ConfigPath
    Path to configuration JSON. Defaults to './deploy.config.json'.

.EXAMPLE
    .\deploy.ps1 -Target central
    .\deploy.ps1 -Target mirror
    .\deploy.ps1 -Target all
#>

param(
    [ValidateSet("central", "mirror", "all")]
    [string]$Target = "central",
    [string]$ConfigPath = "./deploy.config.json"
)

function Deploy-ShellyScript {
    param(
        [string]$DeviceIp,
        [int]$ScriptId,
        [string]$FilePath,
        [hashtable]$PeerIps
    )

    if (-not (Test-Path $FilePath)) {
        Write-Error "Script file not found: $FilePath"
        return $false
    }

    Write-Host "`n========================================================" -ForegroundColor Cyan
    Write-Host " Deploying to Shelly at $DeviceIp (Script ID: $ScriptId)" -ForegroundColor Cyan
    Write-Host " Source: $FilePath" -ForegroundColor Cyan
    Write-Host "========================================================" -ForegroundColor Cyan

    $code = [System.IO.File]::ReadAllText($FilePath, [System.Text.Encoding]::UTF8)

    # In-memory IP injection: Replace placeholder IPs with real peer IPs if provided
    if ($PeerIps) {
        Write-Host "Injecting local network peer IPs..." -ForegroundColor Yellow
        if ($PeerIps.ContainsKey("plinthIP")) {
            $code = $code -replace '192\.168\.1\.101', $PeerIps["plinthIP"]
        }
        if ($PeerIps.ContainsKey("towelRailIP")) {
            $code = $code -replace '192\.168\.1\.102', $PeerIps["towelRailIP"]
        }
        if ($PeerIps.ContainsKey("mirrorIP")) {
            $code = $code -replace '192\.168\.1\.103', $PeerIps["mirrorIP"]
        }
    }

    Write-Host "Payload size: $($code.Length) characters"

    # 1. Disable auto-restart and stop script
    Write-Host "Disabling auto-restart and stopping script $ScriptId..."
    try {
        Invoke-RestMethod -Proxy $null -Method Post -Uri "http://$DeviceIp/rpc/Script.SetConfig" `
            -Body (@{ id = $ScriptId; config = @{ enable = $false } } | ConvertTo-Json) `
            -ContentType "application/json" -TimeoutSec 5 | Out-Null
        $stopRes = Invoke-RestMethod -Proxy $null -Method Post -Uri "http://$DeviceIp/rpc/Script.Stop" `
            -Body (@{ id = $ScriptId } | ConvertTo-Json) `
            -ContentType "application/json" -TimeoutSec 5
        Write-Host "Stopped: $($stopRes | ConvertTo-Json -Compress)"
    } catch {
        Write-Host "Stop returned: $($_.Exception.Message)"
    }

    Start-Sleep -Milliseconds 800

    # Verify stopped
    try {
        $status = Invoke-RestMethod -Proxy $null -Uri "http://$DeviceIp/rpc/Script.GetStatus?id=$ScriptId" -TimeoutSec 5
        if ($status.running) {
            Write-Error "Script is still running on $DeviceIp! Cannot upload."
            return $false
        }
    } catch {
        Write-Error "Unable to communicate with Shelly at http://${DeviceIp} - $($_.Exception.Message)"
        return $false
    }

    # 2. Upload in 1024-byte chunks with retry logic
    $chunkSize = 1024
    $offset = 0
    $append = $false

    while ($offset -lt $code.Length) {
        $len = [Math]::Min($chunkSize, $code.Length - $offset)
        $chunk = $code.Substring($offset, $len)

        $payload = [ordered]@{
            id = $ScriptId
            append = $append
            code = $chunk
        } | ConvertTo-Json

        $uploaded = $false
        for ($attempt = 1; $attempt -le 5; $attempt++) {
            try {
                $putRes = Invoke-RestMethod -Proxy $null -Method Post -Uri "http://$DeviceIp/rpc/Script.PutCode" `
                    -Body $payload -ContentType "application/json" -TimeoutSec 10
                Write-Host "Uploaded chunk ($offset to $($offset + $len) of $($code.Length)): len=$($putRes.len)"
                $uploaded = $true
                break
            } catch {
                Write-Host "Attempt $attempt failed for chunk at offset ${offset}: $($_.Exception.Message). Retrying..." -ForegroundColor Yellow
                Start-Sleep -Milliseconds 800
            }
        }

        if (-not $uploaded) {
            Write-Error "Failed to upload chunk at offset $offset after 5 attempts. Aborting."
            return $false
        }

        $offset += $len
        if (-not $append) {
            Start-Sleep -Milliseconds 500  # Settle time for initial flash sector erase
        } else {
            Start-Sleep -Milliseconds 120
        }
        $append = $true
    }

    Start-Sleep -Milliseconds 500

    # 3. Re-enable auto-start and launch script
    Write-Host "Re-enabling auto-start..."
    Invoke-RestMethod -Proxy $null -Method Post -Uri "http://$DeviceIp/rpc/Script.SetConfig" `
        -Body (@{ id = $ScriptId; config = @{ enable = $true } } | ConvertTo-Json) `
        -ContentType "application/json" -TimeoutSec 5 | Out-Null

    Write-Host "Starting script $ScriptId..."
    $startRes = Invoke-RestMethod -Proxy $null -Method Post -Uri "http://$DeviceIp/rpc/Script.Start" `
        -Body (@{ id = $ScriptId } | ConvertTo-Json) `
        -ContentType "application/json" -TimeoutSec 5
    Write-Host "Started: $($startRes | ConvertTo-Json -Compress)"

    Start-Sleep -Seconds 1

    # 4. Check status
    $status = Invoke-RestMethod -Proxy $null -Uri "http://$DeviceIp/rpc/Script.GetStatus?id=$ScriptId" -TimeoutSec 5
    Write-Host "Live Status: running=$($status.running) mem_used=$($status.mem_used) cpu=$($status.cpu)" -ForegroundColor Green

    # 5. Verify /script/1/status telemetry endpoint
    try {
        $telemetry = Invoke-RestMethod -Proxy $null -Uri "http://$DeviceIp/script/$ScriptId/status" -TimeoutSec 5
        Write-Host "Telemetry endpoint verified: $(($telemetry | ConvertTo-Json -Compress).Substring(0, [Math]::Min(120, ($telemetry | ConvertTo-Json -Compress).Length)))..." -ForegroundColor Green
    } catch {
        Write-Host "Telemetry endpoint not yet responding: $($_.Exception.Message)" -ForegroundColor Yellow
    }

    return $true
}

# Load configuration
if (Test-Path $ConfigPath) {
    Write-Host "Loading configuration from $ConfigPath" -ForegroundColor DarkCyan
    $cfg = Get-Content -Raw -Path $ConfigPath | ConvertFrom-Json
} elseif (Test-Path "./deploy.config.example.json") {
    Write-Host "Warning: deploy.config.json not found. Using defaults from deploy.config.example.json" -ForegroundColor Yellow
    $cfg = Get-Content -Raw -Path "./deploy.config.example.json" | ConvertFrom-Json
} else {
    Write-Error "No configuration file found. Copy deploy.config.example.json to deploy.config.json and set your device IPs."
    exit 1
}

# Convert peers PSCustomObject to hashtable if present
$peerIps = @{}
if ($cfg.peers) {
    foreach ($prop in $cfg.peers.PSObject.Properties) {
        $peerIps[$prop.Name] = $prop.Value
    }
}

if ($Target -eq "central" -or $Target -eq "all") {
    Deploy-ShellyScript -DeviceIp $cfg.central.ip -ScriptId $cfg.central.scriptId `
        -FilePath "./scripts/central_controller.js" -PeerIps $peerIps
}

if ($Target -eq "mirror" -or $Target -eq "all") {
    Deploy-ShellyScript -DeviceIp $cfg.mirror.ip -ScriptId $cfg.mirror.scriptId `
        -FilePath "./scripts/vanity_mirror_controller.js"
}

Write-Host "`nDeployment completed successfully." -ForegroundColor Green
