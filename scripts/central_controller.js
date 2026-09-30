/**
 * ========================================================================
 * CENTRAL BATHROOM CONTROLLER V3 - COMPLETE SERVICE ARCHITECTURE
 * Location: Ceiling Central Junction Box (192.168.1.100)
 * Hardware: Shelly 2PM Gen 4 (S4SW-002P16EU)
 * 
 * Connected Nodes:
 * - Ceiling Downlights: Relay 0 (Local)
 * - Extractor Fan:      Relay 1 (Local)
 * - Plinth Mood Strip:  Shelly Plus RGBW PM (192.168.1.101)
 * - Heated Towel Rail:  Shelly 1 PM Mini Gen 4 (192.168.1.102)
 * - Vanity Mirror:      Shelly 1 Gen 4 (192.168.1.103)
 * - Environment Sensor: Shelly BLU H&T Display (Countertop)
 * 
 * Core Capabilities:
 * 1. Circadian Nighttime Mode (Plinth automatically dims to 30% between 22:30-06:30)
 * 2. Visual Alert Engine with Custom Brightness Overrides & Repeat Multipliers
 * 3. Zero Custom Virtual Components (Clean Shelly app tile; logs to console/HA)
 * 4. Milestone-Only KVS State Tracking (Flash-safe, queryable via KVS.GetMany)
 * 5. mmWave Occupancy Tracking (Sees through glass, no 20m timer needed)
 * 6. 10-Second Pre-Vacancy Warning Flash (Gentle pulse before lights turn off)
 * 7. 15-Second Anti-Timeout State Restoration (Caches & restores exact lighting/dim level)
 * 8. 5-Minute Continuous Occupancy Odor Clearance (Automatic fan start)
 * 9. Anti-Creep Humidity Baseline Lock (Freezes EMA baseline during showers)
 * 10. Heated Towel Rail Thermostat with Night Quiet Hours (<16°C ON, >=18°C OFF)
 * 11. Pull Cord Gesture Decoder (Single: Lights / Double: Fan + 30m Quiet Block)
 * ========================================================================
 */

// ========================================================================
// 1. CONFIGURATION & CONSTANTS
// ========================================================================

const STATES = {
  PRESENCE: { VACANT: "VACANT", PRESENT: "PRESENT", WARNING: "WARNING" },
  FAN:      { OFF: "OFF", ON_HUM: "ON_HUM", ON_MANUAL: "ON_MANUAL", OFF_PENDING: "OFF_PENDING", OFF_BLOCKED: "OFF_BLOCKED" },
  LIGHT:    { ON: "ON", OFF: "OFF" }
};

const CONFIG = {
  // Physical I/O Channels
  swLight:               0,                  // Switch 0: Ceiling Downlights (4x Spotlights)
  swFan:                 1,                  // Switch 1: Extractor Fan
  inputPull:             "input:0",          // Input 0: Pull Cord (Detached)
  inputPIR:              "input:1",          // Input 1: mmWave Occupancy Sensor (Detached)

  // BTHome Environmental Sensors (Countertop BLU H&T Display)
  humSensor:             "bthomesensor:202", // Relative Humidity (%)
  tempSensor:            "bthomesensor:203", // Temperature (°C)
  lightSensor:           "bthomesensor:201", // Ambient Background Light (Binary: true = illuminated, false = dark)
  batSensor:             "bthomesensor:200", // Battery Level (%)
  btDevice:              "bthomedevice:200", // Master BLE Device

  // Network Peer Devices (Local Subnet RPC)
  plinthIP:              "192.168.1.101",     // Shelly Plus RGBW PM
  towelRailIP:           "192.168.1.102",     // Shelly 1 PM Mini Gen 4
  mirrorIP:              "192.168.1.103",     // Shelly 1 Gen 4 (Vanity Mirror)

  // Circadian & Ambient Nighttime Mode & Plinth Brightness
  nightModeSource:       "SENSOR",           // "SENSOR" (Sensor priority with solar/schedule backup), "SCHEDULE", "SOLAR", or "HYBRID"
  useSolarSchedule:      true,               // Automatically track sunset/sunrise for schedule backup
  sensorStaleTimeout:    1800,               // 30 minutes: If no BLE packet within 1800s, sensor is stale -> solar backup
  nightStart:            "22:30",            // Fixed clock fallback start (used if useSolarSchedule is false)
  nightEnd:              "06:30",            // Fixed clock fallback end (used if useSolarSchedule is false)
  plinthDayBrightness:   100,                // 100% white channel in daytime
  plinthNightBrightness: 30,                 // 30% white channel at night (gentle pathfinder)
  plinthNormalTransition: 1.0,               // 1.0s gentle fade during normal day/night operation

  // Environmental Extraction Tuning
  emaAlpha:              0.025,              // Baseline EMA smoothing weight
  trigOffsetHum:         10.0,               // % RH above baseline to trigger fan
  stopOffsetHum:         5.0,                // % RH above baseline to stop fan
  fanMinRun:             600,                // 10 minutes minimum runtime (seconds)
  fanMaxRun:             7200,               // 2 hours safety cutoff (seconds)
  fanBlockTime:          1800,               // 30 minutes manual quiet-mode block (seconds)
  fanManualOverrun:      600,                // 10 minutes overrun after vacancy for manual or odor clearance runs (seconds)

  // Occupancy & Lighting Tuning
  odorDelayTime:         300,                // 5 minutes continuous occupancy before fan starts
  warningTime:           10,                 // 10 seconds pre-vacancy warning flash
  restoreWindow:         15,                 // 15 seconds anti-timeout state restoration window
  doublePullGap:         1200,               // Max ms between pulls for double-pull gesture

  // Heated Towel Rail Thermostat & Quiet Hours
  thermoSetpoint:        16.0,               // Towel rail ON when counter temp < 16.0°C
  thermoHyst:            2.0,                // Towel rail OFF when counter temp >= 18.0°C
  thermoQuietStart:      "22:30",            // 10:30 PM: Heating quiet hours start
  thermoQuietEnd:        "06:30",            // 06:30 AM: Heating quiet hours end
  thermoKeepAliveInterval: 1200              // 20 minutes: Refresh pulse to reset Mini's 1-hour hardware safety timer
};

// ========================================================================
// 2. DECLARATIVE VISUAL ALERT PATTERNS (With Brightness & Repeat)
// ========================================================================

const PATTERNS = {
  // 🚪 Ring Doorbell: Alternates Downlights vs Plinth (at 100% brightness) 3 times (1.0s interval, instant snap)
  doorbell: {
    intervalSec: 1.0,
    repeat: 3,
    plinthTransition: 0.0, // 0.0s instant snap for doorbell
    steps: [
      { light: false, plinth: { on: true, brightness: 100 } },
      { light: true,  plinth: { on: false } }
    ]
  },

  // 🌙 Gentle Notice: Soft pulses of the plinth strip at 30% (leaves downlights untouched)
  gentle: {
    intervalSec: 0.8,
    repeat: 2,
    plinthTransition: 0.5, // 0.5s gentle breathing pulse for gentle notice
    steps: [
      { plinth: { on: false } },
      { plinth: { on: true, brightness: 30 } }
    ]
  },

  // 🚨 Urgent Alarm: Rapid synchronised strobe 6 times at full 100% brightness
  urgent: {
    intervalSec: 0.25,
    repeat: 6,
    plinthTransition: 0.0, // 0.0s instant snap for urgent alarm
    steps: [
      { light: true,  plinth: { on: true, brightness: 100 } },
      { light: false, plinth: { on: false } }
    ]
  }
};

// ========================================================================
// 3. CENTRAL TIMER MANAGER (Leak-Free & Safe)
// ========================================================================

const TimerManager = {
  _timers: {},

  start: function (name, durationSec, callback) {
    this.cancel(name);
    try {
      this._timers[name] = Timer.set(durationSec * 1000, false, function () {
        TimerManager._timers[name] = null;
        try {
          callback();
        } catch (e) {
          logEvent("TimerManager", "Callback error in " + name + ": " + e);
        }
      });
    } catch (e) {
      logEvent("TimerManager", "Failed to start timer " + name + ": " + e);
    }
  },

  interval: function (name, durationSec, callback) {
    this.cancel(name);
    try {
      this._timers[name] = Timer.set(durationSec * 1000, true, function () {
        try {
          callback();
        } catch (e) {
          logEvent("TimerManager", "Interval callback error in " + name + ": " + e);
        }
      });
    } catch (e) {
      logEvent("TimerManager", "Failed to start interval " + name + ": " + e);
    }
  },

  cancel: function (name) {
    if (this._timers[name]) {
      try {
        Timer.clear(this._timers[name]);
      } catch (e) {
        // Ignore invalid handle
      }
      this._timers[name] = null;
    }
  },

  isActive: function (name) {
    return !!this._timers[name];
  }
};

// ========================================================================
// 4. SAFE RPC CALL QUEUE & KVS WRITER (Prevents Queue Overflow & Flash Wear)
// ========================================================================

function logEvent(tag, message) {
  let d = new Date();
  let h = ("0" + d.getHours()).slice(-2);
  let m = ("0" + d.getMinutes()).slice(-2);
  let s = ("0" + d.getSeconds()).slice(-2);
  console.log("[" + h + ":" + m + ":" + s + "][" + tag + "] " + message);
}

const RpcQueue = {
  _queue: [],
  _inFlight: 0,
  _maxInFlight: 2,
  _retryTimerActive: false,

  call: function (method, params, callback) {
    if (this._queue.length >= 10) {
      logEvent("RpcQueue", "Warning: Queue full (10), dropping call to " + method);
      return;
    }
    this._queue.push({ method: method, params: params, callback: callback });
    this._drain();
  },

  _drain: function () {
    if (this._inFlight >= this._maxInFlight || this._queue.length === 0) return;

    let item = this._queue[0];
    this._queue = this._queue.slice(1);
    this._inFlight++;

    let self = this;
    try {
      Shelly.call(item.method, item.params, function (res, errCode, errMsg) {
        self._inFlight--;
        if (self._inFlight < 0) self._inFlight = 0;

        if (typeof item.callback === "function") {
          try {
            item.callback(res, errCode, errMsg);
          } catch (e) {
            logEvent("RpcQueue", "Callback error in " + item.method + ": " + e);
          }
        }
        self._drain();
      });
    } catch (e) {
      self._inFlight--;
      if (self._inFlight < 0) self._inFlight = 0;
      logEvent("RpcQueue", "Shelly.call exception on " + item.method + ": " + e);

      if (!self._retryTimerActive) {
        self._retryTimerActive = true;
        Timer.set(200, false, function () {
          self._retryTimerActive = false;
          self._drain();
        });
      }
    }
  }
};

const KvsCache = {};

function writeKVS(key, value) {
  if (KvsCache[key] === value) return; // Deduplicate to avoid redundant RPC slots and flash wear
  KvsCache[key] = value;
  RpcQueue.call("KVS.Set", { key: key, value: value });
}

function isTimeBetween(startStr, endStr) {
  let d = new Date();
  let curMin = d.getHours() * 60 + d.getMinutes();

  let sParts = startStr.split(":");
  let startMin = Number(sParts[0]) * 60 + Number(sParts[1]);

  let eParts = endStr.split(":");
  let endMin = Number(eParts[0]) * 60 + Number(eParts[1]);

  if (startMin > endMin) {
    // Overnight window (e.g. 22:30 to 06:30)
    return (curMin >= startMin || curMin < endMin);
  } else {
    return (curMin >= startMin && curMin < endMin);
  }
}

// ========================================================================
// 5. STATE RESTORATION SERVICE (Snapshot Engine)
// ========================================================================

const StateRestorer = {
  snapshot: null,
  restoreUntilTs: 0,

  save: function () {
    this.snapshot = {
      ts: Date.now() / 1000,
      spotlightOn: (SpotlightService.state === STATES.LIGHT.ON),
      ambienceOn: (AmbienceService.state === STATES.LIGHT.ON),
      ambienceBrightness: AmbienceService.currentBrightness,
      fanState: FanService.state
    };
  },

  restore: function () {
    if (!this.snapshot) return false;

    let now = Date.now() / 1000;
    let diff = now - this.snapshot.ts;

    if (diff <= CONFIG.restoreWindow) {
      this.restoreUntilTs = Date.now() + 1000;
      logEvent("StateRestorer", "Restoring prior lighting state (" + diff.toFixed(1) + "s ago)");

      SpotlightService.set(this.snapshot.spotlightOn);
      AmbienceService.set(this.snapshot.ambienceOn, this.snapshot.ambienceBrightness);

      this.snapshot = null;
      return true;
    }

    this.snapshot = null;
    return false;
  }
};

// ========================================================================
// 6. SPOTLIGHT SERVICE (Ceiling Downlights Relay 0)
// ========================================================================

const SpotlightService = {
  state: STATES.LIGHT.OFF,

  set: function (turnOn) {
    this.state = turnOn ? STATES.LIGHT.ON : STATES.LIGHT.OFF;
    RpcQueue.call("Switch.Set", { id: CONFIG.swLight, on: turnOn });
    logEvent("Spotlight", "Set to " + this.state);
  },

  toggle: function () {
    this.set(this.state === STATES.LIGHT.OFF);
  },

  handleEvent: function (isOn) {
    if (PresenceService.state === STATES.PRESENCE.WARNING || (Date.now() < StateRestorer.restoreUntilTs) || AlertService.isPlaying) return;
    this.state = isOn ? STATES.LIGHT.ON : STATES.LIGHT.OFF;
  }
};

// ========================================================================
// 7. AMBIENCE & MIRROR SERVICES (Plinth RGBW & Vanity Mirror)
// ========================================================================

const AmbienceService = {
  state: STATES.LIGHT.OFF,
  currentBrightness: 100,
  lastBackgroundDark: true, // Sampled from light sensor while room is unlit

  updateBackgroundLight: function (isLightDetected) {
    // Only update background ambient reading when all bathroom lights are OFF
    // This prevents the bathroom's own spotlights or plinth from corrupting the baseline!
    if (this.state === STATES.LIGHT.OFF && SpotlightService.state === STATES.LIGHT.OFF) {
      this.lastBackgroundDark = !isLightDetected;
      logEvent("Ambience", "Background Ambient Light Update: " + (isLightDetected ? "Illuminated (Day)" : "Dark (Night)"));
    }
  },

  solarNight: true, // Synced via astronomical @sunset/@sunrise schedule jobs and KVS

  setSolarNight: function (isNight) {
    this.solarNight = !!isNight;
    logEvent("Ambience", "Astronomical Solar Schedule: " + (isNight ? "Sunset -> Solar Night" : "Sunrise -> Solar Day"));
  },

  isScheduleNight: function () {
    if (CONFIG.useSolarSchedule) {
      return this.solarNight;
    }
    return isTimeBetween(CONFIG.nightStart, CONFIG.nightEnd);
  },

  isNightMode: function () {
    let sLight = Shelly.getComponentStatus(CONFIG.lightSensor);
    let nowSec = Math.floor(Date.now() / 1000);
    let isStale = (!sLight || typeof sLight.last_updated_ts !== "number" || (nowSec - sLight.last_updated_ts) > CONFIG.sensorStaleTimeout);

    if (CONFIG.nightModeSource === "SENSOR") {
      if (!isStale) {
        // Sensor has priority and reading is fresh!
        return this.lastBackgroundDark;
      } else {
        // Sensor is stale (BLE disconnect or dead battery) -> Fallback to solar/clock schedule
        let isNight = this.isScheduleNight();
        logEvent("Ambience", "Light sensor stale (> " + CONFIG.sensorStaleTimeout + "s). Using " + (CONFIG.useSolarSchedule ? "astronomical solar" : "clock") + " schedule backup (" + (isNight ? "Night" : "Day") + ").");
        return isNight;
      }
    }

    if (CONFIG.nightModeSource === "SOLAR") {
      return this.solarNight;
    }

    if (CONFIG.nightModeSource === "SCHEDULE") {
      return isTimeBetween(CONFIG.nightStart, CONFIG.nightEnd);
    }

    // HYBRID: Active when solar/clock night window is active AND verified by dark ambient background
    if (!isStale) {
      return this.isScheduleNight() && this.lastBackgroundDark;
    } else {
      return this.isScheduleNight();
    }
  },

  set: function (turnOn, overrideBrightness) {
    this.state = turnOn ? STATES.LIGHT.ON : STATES.LIGHT.OFF;

    if (!turnOn) {
      let payload = JSON.stringify({ id: 1, method: "RGBW.Set", params: { id: 0, on: false } });
      RpcQueue.call("HTTP.POST", { url: "http://" + CONFIG.plinthIP + "/rpc", body: payload });
      return;
    }

    // Determine Brightness:
    // 1. Explicit override passed in (e.g. from a Pattern or StateRestorer)
    // 2. Or automatic Nighttime (30%) vs Daytime (100%)
    let bPct = CONFIG.plinthDayBrightness;
    let nightActive = this.isNightMode();
    if (typeof overrideBrightness === "number") {
      bPct = overrideBrightness;
    } else if (nightActive) {
      bPct = CONFIG.plinthNightBrightness;
    }
    this.currentBrightness = bPct;

    let whiteVal = Math.round(bPct * 2.55); // 0-100% -> 0-255
    let payload = JSON.stringify({
      id: 1,
      method: "RGBW.Set",
      params: { id: 0, on: true, brightness: bPct, white: whiteVal }
    });
    RpcQueue.call("HTTP.POST", { url: "http://" + CONFIG.plinthIP + "/rpc", body: payload });
    logEvent("Ambience", "Set ON at " + bPct + "% brightness (white: " + whiteVal + ") [NightMode: " + nightActive + "]");
  }
};

const MirrorService = {
  set: function (turnOn) {
    let payload = JSON.stringify({ id: 1, method: "Boolean.Set", params: { id: 200, value: turnOn } });
    RpcQueue.call("HTTP.POST", { url: "http://" + CONFIG.mirrorIP + "/rpc", body: payload });
  }
};

// ========================================================================
// 8. PRESENCE SERVICE (mmWave Native Tracking & 5m Odor Timer)
// ========================================================================

const PresenceService = {
  state: STATES.PRESENCE.VACANT,

  update: function (isOccupied) {
    if (isOccupied) {
      logEvent("Presence", "Occupancy Active");

      TimerManager.cancel("presence_warning");
      TimerManager.cancel("pulse_toggle");

      // If fan was in manual overrun pending turn-off, re-engage it to active manual run
      if (FanService.state === STATES.FAN.OFF_PENDING && !FanService.targetHum) {
        logEvent("Fan", "Occupant returned during manual overrun -> Re-engaging ON_MANUAL");
        TimerManager.cancel("fan_off");
        FanService.state = STATES.FAN.ON_MANUAL;
      }

      // 5-Minute Continuous Occupancy Odor Timer
      if (!TimerManager.isActive("odor_clearance") && FanService.state === STATES.FAN.OFF) {
        TimerManager.start("odor_clearance", CONFIG.odorDelayTime, function () {
          logEvent("Presence", "5-Minute Continuous Occupancy Reached -> Engaging Odor Extraction");
          FanService.requestOn("OdorClearance");
        });
      }

      // Try to restore previous lighting snapshot if re-triggered within 15s
      let wasRestored = StateRestorer.restore();
      if (!wasRestored && this.state === STATES.PRESENCE.VACANT) {
        // First entry into vacant room:
        // Plinth turns on at Nighttime (30%) or Daytime (100%) brightness automatically!
        AmbienceService.set(true);
        MirrorService.set(true);
      }
      this.state = STATES.PRESENCE.PRESENT;

    } else {
      logEvent("Presence", "Occupancy Inactive (1m Hardware DIP Expired)");

      // Cancel 5m odor timer if occupant leaves before 5 minutes
      TimerManager.cancel("odor_clearance");

      if (this.state === STATES.PRESENCE.PRESENT) {
        // Enter gentle 10-second pre-vacancy warning flash
        this.enterWarning();
      }
    }
  },

  enterWarning: function () {
    this.state = STATES.PRESENCE.WARNING;
    logEvent("Presence", "Entering 10s Pre-Vacancy Warning Flash");
    StateRestorer.save();

    let togglePulse = false;
    if (SpotlightService.state === STATES.LIGHT.ON) {
      RpcQueue.call("Switch.Set", { id: CONFIG.swLight, on: false });
      TimerManager.interval("pulse_toggle", 1.0, function () {
        togglePulse = !togglePulse;
        RpcQueue.call("Switch.Set", { id: CONFIG.swLight, on: togglePulse });
      });
    } else if (AmbienceService.state === STATES.LIGHT.ON) {
      // If downlights are off, pulse the plinth strip at current dim level
      let activeBrightness = AmbienceService.currentBrightness;
      TimerManager.interval("pulse_toggle", 1.0, function () {
        togglePulse = !togglePulse;
        AmbienceService.set(togglePulse, activeBrightness);
      });
    }

    TimerManager.start("presence_warning", CONFIG.warningTime, function () {
      PresenceService.enterVacant();
    });
  },

  enterVacant: function () {
    this.state = STATES.PRESENCE.VACANT;
    TimerManager.cancel("pulse_toggle");
    logEvent("Presence", "Room Cleared -> Vacant");

    SpotlightService.set(false);
    AmbienceService.set(false);
    MirrorService.set(false);

    // Stop manual/odor fan runs upon vacancy (humidity extraction keeps running if active)
    if (FanService.state === STATES.FAN.ON_MANUAL) {
      FanService.requestOff("Vacancy");
    }
  }
};

// ========================================================================
// 9. HUMIDITY SERVICE (With Anti-Creep Baseline Freeze)
// ========================================================================

const HumidityService = {
  ema: 55.0,
  isSpiking: false,
  lastProcessTs: 0,

  update: function (currentHum) {
    let now = Date.now();
    if ((now - this.lastProcessTs) < 5000) return;
    this.lastProcessTs = now;

    // Run fan watchdog checks on each sensor update
    let now_ts = Math.floor(now / 1000);
    FanService.checkWatchdog(now_ts);

    // ANTI-CREEP BASELINE LOCK:
    // Freeze EMA baseline updates while extraction is running.
    // The baseline stays locked at the true pre-shower dry room level!
    if (FanService.state !== STATES.FAN.ON_HUM) {
      let a = CONFIG.emaAlpha;
      this.ema = (a * currentHum) + ((1 - a) * this.ema);
    }

    let trigThreshold = this.ema + CONFIG.trigOffsetHum;
    let stopThreshold = this.ema + CONFIG.stopOffsetHum;

    if (currentHum > trigThreshold) {
      this.isSpiking = true;
      FanService.requestOn("HumiditySpike", stopThreshold);
    } else if (currentHum <= stopThreshold) {
      // ONLY request turn-off if humidity was actually spiking or fan is in humidity mode!
      // NEVER interfere with manual or odor clearance runs!
      if (this.isSpiking || FanService.state === STATES.FAN.ON_HUM) {
        this.isSpiking = false;
        FanService.requestOff("TargetReached");
      }
    }
  }
};

// ========================================================================
// 10. THERMOSTAT SERVICE (Heated Towel Rail with Night Quiet Hours)
// ========================================================================

const ThermostatService = {
  isHeating: false,
  lastCheckTs: 0,
  lastKeepAliveTs: 0,

  update: function (currentTemp) {
    let now = Date.now();
    if ((now - this.lastCheckTs) < 30000) return; // Evaluate at most every 30 seconds
    this.lastCheckTs = now;

    // Check Quiet Hours: Suppress towel rail heating during sleeping hours
    if (isTimeBetween(CONFIG.thermoQuietStart, CONFIG.thermoQuietEnd)) {
      if (this.isHeating) {
        this.isHeating = false;
        this.lastKeepAliveTs = 0;
        logEvent("Thermostat", "Quiet Hours active (" + CONFIG.thermoQuietStart + " - " + CONFIG.thermoQuietEnd + "). Turning Towel Rail OFF");

        let payload = JSON.stringify({ id: 1, method: "Switch.Set", params: { id: 0, on: false } });
        RpcQueue.call("HTTP.POST", { url: "http://" + CONFIG.towelRailIP + "/rpc", body: payload }, function (res, err) {
          if (err) logEvent("Thermostat", "Failed to reach Towel Rail: " + err);
        });
      }
      return;
    }

    let nowSec = Math.floor(now / 1000);

    // Normal Daytime: Turn ON towel rail if room temperature drops below setpoint (< 16.0°C)
    if (currentTemp < CONFIG.thermoSetpoint) {
      if (!this.isHeating) {
        this.isHeating = true;
        this.lastKeepAliveTs = nowSec;
        logEvent("Thermostat", "Temp (" + currentTemp.toFixed(1) + "°C) < Setpoint (" + CONFIG.thermoSetpoint + "°C). Turning Towel Rail ON");

        let payload = JSON.stringify({ id: 1, method: "Switch.Set", params: { id: 0, on: true } });
        RpcQueue.call("HTTP.POST", { url: "http://" + CONFIG.towelRailIP + "/rpc", body: payload }, function (res, err) {
          if (err) logEvent("Thermostat", "Failed to reach Towel Rail: " + err);
        });
      } else if ((nowSec - this.lastKeepAliveTs) >= CONFIG.thermoKeepAliveInterval) {
        // Keep-alive refresh: resets the Mini's 1-hour hardware safety timer
        this.lastKeepAliveTs = nowSec;
        logEvent("Thermostat", "Keep-alive pulse to Towel Rail (resets 1h hardware safety timer)");
        let payload = JSON.stringify({ id: 1, method: "Switch.Set", params: { id: 0, on: true } });
        RpcQueue.call("HTTP.POST", { url: "http://" + CONFIG.towelRailIP + "/rpc", body: payload });
      }
    }
    // Turn OFF when room recovers past setpoint + hysteresis (>= 18.0°C)
    else if (currentTemp >= (CONFIG.thermoSetpoint + CONFIG.thermoHyst) && this.isHeating) {
      this.isHeating = false;
      this.lastKeepAliveTs = 0;
      logEvent("Thermostat", "Temp (" + currentTemp.toFixed(1) + "°C) recovered. Turning Towel Rail OFF");

      let payload = JSON.stringify({ id: 1, method: "Switch.Set", params: { id: 0, on: false } });
      RpcQueue.call("HTTP.POST", { url: "http://" + CONFIG.towelRailIP + "/rpc", body: payload }, function (res, err) {
        if (err) logEvent("Thermostat", "Failed to reach Towel Rail: " + err);
      });
    }
  }
};

// ========================================================================
// 11. EXTRACTOR FAN SERVICE (FSM & Quiet Mode Watchdog)
// ========================================================================

const FanService = {
  state: STATES.FAN.OFF,
  startTime: 0,
  targetHum: 0,
  blockUntilTs: 0,
  pendingOffTs: 0,

  isBlocked: function (now_ts) {
    if (!this.blockUntilTs) return false;
    if (this.blockUntilTs > (now_ts + 86400)) { // Watchdog for RTC jump
      this.blockUntilTs = 0;
      writeKVS("auto_block_ts", 0);
      return false;
    }
    if (now_ts >= this.blockUntilTs) {
      this.blockUntilTs = 0;
      writeKVS("auto_block_ts", 0);
      if (this.state === STATES.FAN.OFF_BLOCKED) {
        this._transition(STATES.FAN.OFF, "Quiet Block Expired");
      }
      return false;
    }
    return true;
  },

  checkWatchdog: function (now_ts) {
    // 1. Quiet block expiry check (no timer needed)
    this.isBlocked(now_ts);

    // 2. Overrun / MinRun Pending Off check (fail-safe for long timers)
    if (this.state === STATES.FAN.OFF_PENDING && this.pendingOffTs > 0) {
      if (now_ts >= this.pendingOffTs) {
        this.pendingOffTs = 0;
        this._transition(STATES.FAN.OFF, "Overrun/MinRun Complete (Watchdog)");
        return;
      }
    }

    // 3. Max runtime safety cutoff (2h) (no timer needed)
    if ((this.state === STATES.FAN.ON_HUM || this.state === STATES.FAN.ON_MANUAL) && this.startTime > 0) {
      if ((now_ts - this.startTime) >= CONFIG.fanMaxRun) {
        this._transition(STATES.FAN.OFF, "Max Runtime Cutoff (2h)");
      }
    }
  },

  requestOn: function (reason, targetVal) {
    let now_ts = Math.floor(Date.now() / 1000);
    this.pendingOffTs = 0;

    if (reason === "HumiditySpike") {
      if (this.isBlocked(now_ts)) {
        logEvent("Fan", "Extraction blocked by manual quiet mode until " + this.blockUntilTs);
        return;
      }

      this.targetHum = targetVal || (HumidityService.ema + CONFIG.stopOffsetHum);
      TimerManager.cancel("fan_off");
      this._transition(STATES.FAN.ON_HUM, "Shower Spike (Target: " + this.targetHum.toFixed(1) + "%)");
    }
    else if (reason === "Manual" || reason === "OdorClearance") {
      this.targetHum = 0;
      TimerManager.cancel("fan_off");
      this._transition(STATES.FAN.ON_MANUAL, reason);

      // If forced on while room is vacant, run for manual overrun
      if (PresenceService.state === STATES.PRESENCE.VACANT) {
        let overrun = CONFIG.fanManualOverrun || CONFIG.fanMinRun;
        this.pendingOffTs = now_ts + overrun;
        TimerManager.start("fan_off", overrun, function () {
          FanService._transition(STATES.FAN.OFF, "Vacant Manual Overrun Complete");
        });
      }
    }
  },

  requestOff: function (reason) {
    if (reason === "TargetReached") {
      // TargetReached ONLY applies to humidity extraction!
      if (this.state !== STATES.FAN.ON_HUM) return;

      let now_ts = Math.floor(Date.now() / 1000);
      let runtime = now_ts - this.startTime;

      if (runtime >= CONFIG.fanMinRun) {
        this.pendingOffTs = 0;
        this._transition(STATES.FAN.OFF, reason);
      } else {
        // Enforce 10-minute minimum drying period
        let remaining = CONFIG.fanMinRun - runtime;
        logEvent("Fan", "Target reached, but honoring MinRun (" + remaining + "s left)");
        this.pendingOffTs = now_ts + remaining;
        this._transition(STATES.FAN.OFF_PENDING, "MinRun Wait");

        TimerManager.start("fan_off", remaining, function () {
          FanService._transition(STATES.FAN.OFF, "MinRun Complete");
        });
      }
    } else if (reason === "Vacancy") {
      // Vacancy ONLY stops manual / odor clearance runs
      if (this.state !== STATES.FAN.ON_MANUAL) return;

      let minRun = CONFIG.fanManualOverrun || CONFIG.fanMinRun;
      let now_ts = Math.floor(Date.now() / 1000);
      logEvent("Fan", "Vacancy occurred; running manual/odor overrun (" + minRun + "s)");
      this.pendingOffTs = now_ts + minRun;
      this._transition(STATES.FAN.OFF_PENDING, "Manual Overrun");

      TimerManager.start("fan_off", minRun, function () {
        FanService._transition(STATES.FAN.OFF, "Overrun Complete");
      });
    } else {
      // Explicit manual/app override
      this.pendingOffTs = 0;
      this._transition(STATES.FAN.OFF, reason);
    }
  },

  forceBlock: function () {
    let now_ts = Math.floor(Date.now() / 1000);
    this.blockUntilTs = now_ts + CONFIG.fanBlockTime;
    this.targetHum = 0;
    this.pendingOffTs = 0;
    TimerManager.cancel("fan_off");
    this._transition(STATES.FAN.OFF_BLOCKED, "Double Pull (30m Quiet Block)");
    writeKVS("auto_block_ts", this.blockUntilTs);
  },

  _transition: function (newState, reason) {
    if (this.state === newState) return;
    if (newState === STATES.FAN.OFF) {
      this.pendingOffTs = 0;
    }
    logEvent("Fan", "Transition: " + this.state + " -> " + newState + " (" + reason + ")");
    this.state = newState;

    if (newState === STATES.FAN.ON_HUM || newState === STATES.FAN.ON_MANUAL) {
      RpcQueue.call("Switch.Set", { id: CONFIG.swFan, on: true });
      if (!this.startTime) this.startTime = Math.floor(Date.now() / 1000);
    } else if (newState === STATES.FAN.OFF || newState === STATES.FAN.OFF_BLOCKED) {
      RpcQueue.call("Switch.Set", { id: CONFIG.swFan, on: false });
      this.startTime = 0;
      this.targetHum = 0;
      TimerManager.cancel("fan_off");
    }
  },

  handleEvent: function (isOn) {
    if (isOn && this.state === STATES.FAN.OFF) {
      this._transition(STATES.FAN.ON_MANUAL, "App Override ON");
    } else if (!isOn && this.state !== STATES.FAN.OFF && this.state !== STATES.FAN.OFF_BLOCKED) {
      this._transition(STATES.FAN.OFF, "App Override OFF");
    }
  }
};

// ========================================================================
// 12. VISUAL ALERT & SCENE ENGINE (Declarative Patterns with Custom Brightness)
// ========================================================================

const AlertService = {
  isPlaying: false,

  trigger: function (patternName) {
    if (this.isPlaying) return;
    let selectedPattern = PATTERNS[patternName] || PATTERNS.doorbell;

    this.isPlaying = true;
    logEvent("Alert", "Playing Visual Scene: " + patternName + " (repeat: " + selectedPattern.repeat + ")");

    // 1. Snapshot active room lighting and plinth brightness
    let preDownlightOn = (SpotlightService.state === STATES.LIGHT.ON);
    let prePlinthOn = (AmbienceService.state === STATES.LIGHT.ON);
    let prePlinthBrightness = AmbienceService.currentBrightness;

    // 2. Configure plinth transition for the alert (e.g. 0.0s instant snap)
    let alertTransition = (typeof selectedPattern.plinthTransition === "number") ? selectedPattern.plinthTransition : 0.0;
    let setConfigPayload = JSON.stringify({
      id: 1,
      method: "RGBW.SetConfig",
      params: { id: 0, config: { transition_duration: alertTransition } }
    });
    RpcQueue.call("HTTP.POST", { url: "http://" + CONFIG.plinthIP + "/rpc", body: setConfigPayload });

    // 3. Build flat execution sequence based on repeat count
    let sequence = [];
    for (let r = 0; r < selectedPattern.repeat; r++) {
      for (let s = 0; s < selectedPattern.steps.length; s++) {
        sequence.push(selectedPattern.steps[s]);
      }
    }

    // 4. Step through sequence on the configured interval
    let stepIndex = 0;
    TimerManager.interval("alert_runner", selectedPattern.intervalSec, function () {
      if (stepIndex < sequence.length) {
        let step = sequence[stepIndex];

        // Downlights control
        if (typeof step.light !== "undefined") {
          RpcQueue.call("Switch.Set", { id: CONFIG.swLight, on: step.light });
        }

        // Plinth control with optional explicit brightness override
        if (typeof step.plinth !== "undefined") {
          if (typeof step.plinth === "boolean") {
            AmbienceService.set(step.plinth);
          } else if (typeof step.plinth === "object") {
            AmbienceService.set(step.plinth.on, step.plinth.brightness);
          }
        }
        stepIndex++;
      } else {
        // Sequence Complete: Restore normal operation fade duration (1.0s) & pre-alert state
        TimerManager.cancel("alert_runner");
        logEvent("Alert", "Scene finished. Restoring normal fade (" + CONFIG.plinthNormalTransition + "s) & prior lighting.");

        let restoreConfigPayload = JSON.stringify({
          id: 1,
          method: "RGBW.SetConfig",
          params: { id: 0, config: { transition_duration: CONFIG.plinthNormalTransition } }
        });
        RpcQueue.call("HTTP.POST", { url: "http://" + CONFIG.plinthIP + "/rpc", body: restoreConfigPayload });

        // If room became occupied during alert, preserve active occupancy lighting!
        if (PresenceService.state === STATES.PRESENCE.PRESENT) {
          logEvent("Alert", "Room occupied during alert; maintaining active occupancy lighting.");
          SpotlightService.set(preDownlightOn);
          AmbienceService.set(true);
        } else {
          SpotlightService.set(preDownlightOn);
          AmbienceService.set(prePlinthOn, prePlinthBrightness);
        }

        TimerManager.start("alert_cooldown", 1, function () {
          AlertService.isPlaying = false;
        });
      }
    });
  }
};

// Register HTTP Endpoint: GET http://192.168.1.100/script/1/alert?pattern=doorbell
if (typeof HTTPServer !== "undefined" && typeof HTTPServer.registerEndpoint === "function") {
  HTTPServer.registerEndpoint("alert", function (req, res) {
    let pattern = (req && req.query && req.query.pattern) ? req.query.pattern : "doorbell";
    AlertService.trigger(pattern);
    res.code = 200;
    res.body = JSON.stringify({ success: true, pattern: pattern });
    res.send();
  });
  logEvent("System", "Registered HTTP Endpoint: /script/1/alert");

  // Register HTTP Endpoint: GET http://192.168.1.100/script/1/status
  HTTPServer.registerEndpoint("status", function (req, res) {
    let now = Date.now();
    let now_ts = Math.floor(now / 1000);

    let fanRuntime = (FanService.startTime > 0) ? (now_ts - FanService.startTime) : 0;
    let blockRemaining = (FanService.blockUntilTs > now_ts) ? (FanService.blockUntilTs - now_ts) : 0;

    let sHum = Shelly.getComponentStatus(CONFIG.humSensor);
    let sTemp = Shelly.getComponentStatus(CONFIG.tempSensor);
    let sBat = Shelly.getComponentStatus(CONFIG.batSensor);

    let curHum = (sHum && typeof sHum.value === "number") ? sHum.value : 0;
    let curTemp = (sTemp && typeof sTemp.value === "number") ? sTemp.value : 0;
    let curBat = (sBat && typeof sBat.value === "number") ? sBat.value : 0;

    let trigHum = HumidityService.ema + CONFIG.trigOffsetHum;
    let stopHum = HumidityService.ema + CONFIG.stopOffsetHum;

    let summary = PresenceService.state;
    if (FanService.state === STATES.FAN.ON_HUM) {
      summary += " | Shower Drying (Target: " + stopHum.toFixed(1) + "%)";
    } else if (FanService.state === STATES.FAN.ON_MANUAL) {
      summary += " | Fan Manual/Odor Running";
    } else if (FanService.state === STATES.FAN.OFF_PENDING) {
      summary += " | Fan Overrun Active";
    } else if (FanService.state === STATES.FAN.OFF_BLOCKED) {
      summary += " | Fan Quiet Block (" + Math.ceil(blockRemaining / 60) + "m left)";
    } else {
      summary += " | Idle";
    }

    let report = {
      presence: {
        state: PresenceService.state
      },
      fan: {
        state: FanService.state,
        runtime_sec: fanRuntime,
        blocked: (blockRemaining > 0),
        block_remaining_sec: blockRemaining,
        target_humidity: FanService.targetHum
      },
      humidity: {
        current: curHum,
        ema_baseline: Math.round(HumidityService.ema * 10) / 10,
        trig_threshold: Math.round(trigHum * 10) / 10,
        stop_threshold: Math.round(stopHum * 10) / 10,
        is_spiking: HumidityService.isSpiking
      },
      lighting: {
        downlights: (SpotlightService.state === STATES.LIGHT.ON),
        ambience: (AmbienceService.state === STATES.LIGHT.ON),
        plinth_brightness: AmbienceService.currentBrightness,
        night_mode: AmbienceService.isNightMode(),
        solar_night: AmbienceService.solarNight
      },
      thermostat: {
        heating: ThermostatService.isHeating,
        current_temp: curTemp,
        setpoint: CONFIG.thermoSetpoint
      },
      battery_pct: curBat,
      summary: summary
    };

    res.code = 200;
    res.body = JSON.stringify(report);
    res.send();
  });
  logEvent("System", "Registered HTTP Endpoint: /script/1/status");
}

// ========================================================================
// 13. PULL CORD SERVICE (Physical Contact Decoder)
// ========================================================================

const PullCordService = {
  lastEventTs: 0,
  gestureActive: false,
  cooldownUntilTs: 0,

  handlePull: function () {
    let now = Date.now();

    // 1. Debounce rapid contact chatter / mechanical switch bounce (< 150ms)
    if ((now - this.lastEventTs) < 150) return;
    this.lastEventTs = now;

    // 2. Cooldown period after completed gesture (swallows trailing bounce or multi-tugs)
    if (now < this.cooldownUntilTs) return;

    if (!this.gestureActive) {
      // FIRST PULL:
      this.gestureActive = true;

      // Switch downlights on/off immediately
      SpotlightService.toggle();

      // Arm gesture window timer
      TimerManager.start("pull_gesture", CONFIG.doublePullGap / 1000, function () {
        // Single Pull Confirmed: timer expired with no second pull
        PullCordService.gestureActive = false;
        logEvent("PullCord", "Single Pull Confirmed (Downlights Toggled)");
      });

    } else {
      // SECOND PULL (within doublePullGap):
      TimerManager.cancel("pull_gesture");
      this.gestureActive = false;

      // Double Pull Confirmed: Leave downlights as toggled, toggle fan / quiet block
      if (FanService.state === STATES.FAN.OFF) {
        logEvent("PullCord", "Double Pull: Fan ON");
        FanService.requestOn("Manual");
      } else {
        logEvent("PullCord", "Double Pull: Fan OFF (30m Quiet Block)");
        FanService.forceBlock();
      }

      // 400ms cooldown to swallow extra bounce or multi-tugs
      this.cooldownUntilTs = now + 400;
    }
  }
};

// ========================================================================
// 14. EVENT DISPATCHER
// ========================================================================

Shelly.addStatusHandler(function (event) {
  try {
    // Environmental Sensor Telemetry (BLU H&T Display)
    if (event.component === CONFIG.humSensor || event.component === CONFIG.tempSensor || event.component === CONFIG.lightSensor || event.component === CONFIG.batSensor || event.component === CONFIG.btDevice) {
      let sHum = Shelly.getComponentStatus(CONFIG.humSensor);
      let sTemp = Shelly.getComponentStatus(CONFIG.tempSensor);
      let sLight = Shelly.getComponentStatus(CONFIG.lightSensor);
      let sBat = Shelly.getComponentStatus(CONFIG.batSensor);

      if (sHum && typeof sHum.value === "number") {
        HumidityService.update(sHum.value);
      }
      if (sTemp && typeof sTemp.value === "number") {
        ThermostatService.update(sTemp.value);
      }
      if (sLight && typeof sLight.value === "boolean") {
        AmbienceService.updateBackgroundLight(sLight.value);
      }
      if (sBat && typeof sBat.value === "number") {
        if (sBat.value < 20) {
          logEvent("System", "WARNING: BLU H&T Battery Low (" + sBat.value + "%)");
        }
      }
    }

    // mmWave Occupancy Sensor (Input 1)
    if (event.component === CONFIG.inputPIR && typeof event.delta.state !== "undefined") {
      PresenceService.update(event.delta.state);
    }

    // Physical Pull Cord (Input 0)
    if (event.component === CONFIG.inputPull && typeof event.delta.state !== "undefined") {
      PullCordService.handlePull();
    }

    // Relay 0 Echo
    if (event.component === "switch:" + CONFIG.swLight && typeof event.delta.output !== "undefined") {
      SpotlightService.handleEvent(event.delta.output);
    }

    // Relay 1 Echo
    if (event.component === "switch:" + CONFIG.swFan && typeof event.delta.output !== "undefined") {
      FanService.handleEvent(event.delta.output);
    }
  } catch (e) {
    logEvent("Dispatcher", "Unhandled error in status handler: " + e);
  }
});

// ========================================================================
// 15. BOOTSTRAP INITIALIZATION
// ========================================================================

function init() {
  try {
    logEvent("System", "Central Bathroom Controller V3 Online (Complete Service Architecture)");

    // Initial read of light sensor for background ambient level
    let sLight = Shelly.getComponentStatus(CONFIG.lightSensor);
    if (sLight && typeof sLight.value === "boolean") {
      AmbienceService.lastBackgroundDark = !sLight.value;
    }

    // Initial read of battery sensor
    let sBat = Shelly.getComponentStatus(CONFIG.batSensor);
    if (sBat && typeof sBat.value === "number") {
      logEvent("System", "BLU H&T Battery Level: " + sBat.value + "%");
    }

    // Initial read of humidity sensor to seed EMA baseline
    let sHum = Shelly.getComponentStatus(CONFIG.humSensor);
    if (sHum && typeof sHum.value === "number") {
      HumidityService.ema = sHum.value;
      logEvent("Humidity", "Initialized EMA from current sensor: " + sHum.value + "%");
    }

    // Initialize astronomical solar_night state from KVS via RpcQueue
    RpcQueue.call("KVS.Get", { key: "solar_night" }, function (res, errCode) {
      if (!errCode && res && typeof res.value === "boolean") {
        AmbienceService.solarNight = res.value;
        logEvent("Ambience", "Loaded astronomical solar_night from KVS: " + res.value);
      }
    });

    // Initialize auto_block_ts from KVS
    RpcQueue.call("KVS.Get", { key: "auto_block_ts" }, function (res, errCode) {
      if (!errCode && res && typeof res.value === "number") {
        FanService.blockUntilTs = res.value;
        logEvent("Fan", "Loaded auto_block_ts from KVS: " + res.value);
      }
    });

    let lightCheck = Shelly.getComponentStatus("switch:" + CONFIG.swLight);
    if (lightCheck) SpotlightService.state = lightCheck.output ? STATES.LIGHT.ON : STATES.LIGHT.OFF;

    let fanCheck = Shelly.getComponentStatus("switch:" + CONFIG.swFan);
    if (fanCheck && fanCheck.output) {
      FanService.state = STATES.FAN.ON_MANUAL;
      FanService.startTime = Math.floor(Date.now() / 1000);
    }

    // Boot-time mmWave Occupancy Check: staggered check to ensure network/BLE initialization
    Timer.set(1000, false, function () {
      let pirCheck = Shelly.getComponentStatus(CONFIG.inputPIR);
      if (pirCheck && pirCheck.state === true && PresenceService.state === STATES.PRESENCE.VACANT) {
        logEvent("Presence", "Occupancy detected on boot initialization -> Engaging Presence");
        PresenceService.update(true);
      }
    });

    // Recurring 10-second watchdog tick: failsafe for fan overrun, max runtime, and quiet blocks
    Timer.set(10000, true, function () {
      let now_ts = Math.floor(Date.now() / 1000);
      FanService.checkWatchdog(now_ts);
    });
  } catch (e) {
    logEvent("System", "Fatal bootstrap error caught: " + e);
  }
}

init();
