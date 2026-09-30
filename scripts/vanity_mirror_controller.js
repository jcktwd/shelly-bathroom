/**
 * ========================================================================
 * SHELLY GEN 4 VANITY MIRROR CONTROLLER V2
 * Location: Behind Bathroom Vanity Mirror (192.168.1.103)
 * Hardware: Shelly 1 Gen 4 (S4SW-001X16EU)
 *
 * Hardware Setup:
 * - Shelly Relay Output (O): Dry contact wired across the 3-line IR sensor
 * - Shelly Input (SW / S1): Tapped into the internal demister relay line
 *
 * Features & Reliability Upgrades:
 * 1. Closed-loop state verification (actual physical status vs target state)
 * 2. Bounded retry limit (max 3 pulses) preventing endless mechanical relay wear
 * 3. Independent input debounce and virtual debounce (no cross-lockouts)
 * 4. Boot initialization guard preventing spurious toggles on power-up
 * 5. Native HTTP telemetry endpoint (/script/1/status) for direct LAN scraping
 * 6. Configurable safety demister auto-off watchdog (prevents heating pad burnout)
 * ========================================================================
 */

const CONFIG = {
    outRelay:            0,    // Relay output simulating the IR hand wave
    inSignal:            0,    // Input reading actual state from demister line
    vcMirrorState:       200,  // Virtual Boolean ID for Shelly App / HA
    pulseDuration:       120,  // ms to pulse the IR line (mimics optical wave)
    verifyDelay:         1000, // ms to wait after pulse before verifying physical line
    inputDebounceMs:     600,  // ms debounce for physical demister relay contact noise
    virtualDebounceMs:   800,  // ms debounce to reject rapid app double-clicks
    maxRetries:          3,    // Maximum pulse attempts before aborting
    autoOffMinutes:      60    // Safety auto-cutoff (0 = disabled)
};

const Logger = {
    info: function (tag, msg) {
        console.log("[" + tag + "] " + msg);
    },
    warn: function (tag, msg) {
        console.log("[WARN][" + tag + "] " + msg);
    },
    error: function (tag, msg) {
        console.log("[ERROR][" + tag + "] " + msg);
    }
};

let actualMirrorState = false;
let targetMirrorState = false;
let isPulsing = false;
let isUpdatingVirtual = false;
let isInitialized = false;
let retryCount = 0;

let inputDebounceTimer = null;
let virtualDebounceTimer = null;
let verifyTimer = null;
let autoOffTimer = null;
let turnOnTimestamp = 0;

// Update the Virtual Boolean component without triggering a loop
function updateVirtualState(state) {
    isUpdatingVirtual = true;
    Shelly.call("Boolean.Set", { id: CONFIG.vcMirrorState, value: state }, function (res, err) {
        isUpdatingVirtual = false;
        if (err) {
            Logger.warn("Virtual", "Failed to update Boolean:" + CONFIG.vcMirrorState);
        }
    });
}

// Reset any pending safety auto-off timer
function resetAutoOffTimer() {
    if (autoOffTimer !== null) {
        Timer.clear(autoOffTimer);
        autoOffTimer = null;
    }
    turnOnTimestamp = 0;

    if (actualMirrorState && CONFIG.autoOffMinutes > 0) {
        turnOnTimestamp = Math.floor(Date.now() / 1000);
        autoOffTimer = Timer.set(CONFIG.autoOffMinutes * 60 * 1000, false, function () {
            autoOffTimer = null;
            if (actualMirrorState) {
                Logger.warn("Watchdog", "Mirror exceeded maximum runtime of " + CONFIG.autoOffMinutes + "m. Auto-powering off.");
                requestTargetState(false);
            }
        });
    }
}

// Clean up pending verification timer
function clearVerifyTimer() {
    if (verifyTimer !== null) {
        Timer.clear(verifyTimer);
        verifyTimer = null;
    }
}

// Pulse the IR optical line via relay
function pulseIR() {
    if (isPulsing) {
        return;
    }
    isPulsing = true;
    clearVerifyTimer();

    Logger.info("Sync", "Pulsing IR line (Attempt " + (retryCount + 1) + "/" + CONFIG.maxRetries + ")...");

    Shelly.call("Switch.Set", { id: CONFIG.outRelay, on: true }, function (res, err) {
        if (err) {
            Logger.error("Relay", "Failed to close relay: " + JSON.stringify(err));
            isPulsing = false;
            return;
        }

        Timer.set(CONFIG.pulseDuration, false, function () {
            Shelly.call("Switch.Set", { id: CONFIG.outRelay, on: false }, function (res2, err2) {
                isPulsing = false;
                if (err2) {
                    Logger.error("Relay", "Failed to open relay: " + JSON.stringify(err2));
                }

                // Verify physical response after allowing internal mirror controller to switch
                verifyTimer = Timer.set(CONFIG.verifyDelay, false, function () {
                    verifyTimer = null;
                    checkSync();
                });
            });
        });
    });
}

// Check whether physical state matches target state
function checkSync() {
    if (actualMirrorState === targetMirrorState) {
        if (retryCount > 0) {
            Logger.info("Sync", "Successfully synchronized mirror state after " + (retryCount + 1) + " attempts.");
        }
        retryCount = 0;
        return;
    }

    retryCount++;
    if (retryCount < CONFIG.maxRetries) {
        Logger.warn("Sync", "Mismatch persists (Target: " + targetMirrorState + ", Actual: " + actualMirrorState + "). Retrying pulse...");
        pulseIR();
    } else {
        Logger.error("Sync", "Sync failed after " + CONFIG.maxRetries + " attempts. Mirror isolator may be off or hardware disconnected. Reverting target state.");
        retryCount = 0;
        targetMirrorState = actualMirrorState;
        updateVirtualState(actualMirrorState);
    }
}

// Trigger state change requested by App, Home Assistant, or Central Controller
function requestTargetState(newTarget) {
    if (!isInitialized) {
        Logger.warn("Request", "Ignored: Script is still initializing.");
        return;
    }

    if (virtualDebounceTimer !== null) {
        Logger.info("Virtual", "Rapid request debounced. Setting target to: " + newTarget);
        targetMirrorState = newTarget;
        return;
    }

    targetMirrorState = newTarget;

    // If already in target state, just ensure virtual matches
    if (actualMirrorState === targetMirrorState) {
        updateVirtualState(actualMirrorState);
        return;
    }

    virtualDebounceTimer = Timer.set(CONFIG.virtualDebounceMs, false, function () {
        virtualDebounceTimer = null;
    });

    retryCount = 0;
    pulseIR();
}

// Handle physical change detected on the demister line
function handlePhysicalInputChange(newState) {
    if (!isInitialized) {
        actualMirrorState = newState;
        targetMirrorState = newState;
        return;
    }

    if (inputDebounceTimer !== null) {
        Timer.clear(inputDebounceTimer);
    }

    inputDebounceTimer = Timer.set(CONFIG.inputDebounceMs, false, function () {
        inputDebounceTimer = null;
        actualMirrorState = newState;
        Logger.info("Input", "Physical mirror state settled: " + (actualMirrorState ? "ON" : "OFF"));

        // If a sync was in progress and we reached the target state, clear retries
        if (actualMirrorState === targetMirrorState) {
            retryCount = 0;
            clearVerifyTimer();
        } else if (!isPulsing && verifyTimer === null) {
            // Physical manual hand wave by a human: sync target and virtual component
            targetMirrorState = actualMirrorState;
            updateVirtualState(actualMirrorState);
        }

        resetAutoOffTimer();
    });
}

// Status endpoint registration
function registerStatusEndpoint() {
    try {
        HTTPServer.registerEndpoint("status", function (req, res) {
            let nowSec = Math.floor(Date.now() / 1000);
            let activeRuntime = 0;
            if (actualMirrorState && turnOnTimestamp > 0) {
                activeRuntime = nowSec - turnOnTimestamp;
            }

            let payload = {
                power: actualMirrorState,
                target: targetMirrorState,
                pulsing: isPulsing,
                retries: retryCount,
                runtime_sec: activeRuntime,
                auto_off_limit_min: CONFIG.autoOffMinutes
            };

            res.headers = [["Content-Type", "application/json"]];
            res.body = JSON.stringify(payload);
            res.send();
        });
        Logger.info("HTTP", "Registered status endpoint at /script/1/status");
    } catch (e) {
        Logger.warn("HTTP", "Failed to register HTTP endpoint: " + JSON.stringify(e));
    }
}

// Global Event Handler
Shelly.addStatusHandler(function (status) {
    // 1. Virtual Component Toggled (from App or RPC)
    if (status.component === "boolean:" + CONFIG.vcMirrorState) {
        if (isUpdatingVirtual) {
            return; // Ignore internal self-updates
        }
        if (status.delta && status.delta.value !== undefined) {
            Logger.info("Virtual", "Target state requested: " + status.delta.value);
            requestTargetState(status.delta.value);
        }
    }

    // 2. Physical Demister Line Changed (Input S1)
    if (status.component === "input:" + CONFIG.inSignal) {
        if (status.delta && status.delta.state !== undefined) {
            handlePhysicalInputChange(status.delta.state);
        }
    }
});

// Boot Initialization
function init() {
    Logger.info("System", "Starting Enhanced Vanity Mirror Controller V2...");

    registerStatusEndpoint();

    Shelly.call("Input.GetStatus", { id: CONFIG.inSignal }, function (res, err) {
        if (!err && res && res.state !== undefined) {
            actualMirrorState = res.state;
            targetMirrorState = actualMirrorState;
            isInitialized = true;

            Logger.info("Init", "Physical mirror state on boot: " + (actualMirrorState ? "ON" : "OFF"));
            updateVirtualState(actualMirrorState);
            resetAutoOffTimer();
        } else {
            Logger.error("Init", "Failed to read physical Input state on boot. Initializing as OFF.");
            actualMirrorState = false;
            targetMirrorState = false;
            isInitialized = true;
            updateVirtualState(false);
        }
    });
}

init();
