let websocket = null;
let pluginUUID = null;

// Timer state per action instance (context)
const timers = {};
// timers[ctx] = {
//   durationSeconds: number,    // chosen duration
//   remainingSeconds: number,   // current remaining
//   running: boolean,
//   endTime: number | null,     // timestamp in ms when it should hit 0
//   timeoutId: number | null
// };

function connectElgatoStreamDeckSocket(port, uuid, registerEvent, info) {
    pluginUUID = uuid;

    websocket = new WebSocket(`ws://127.0.0.1:${port}`);

    websocket.onopen = () => {
        websocket.send(JSON.stringify({
            event: registerEvent,
            uuid: pluginUUID
        }));
    };

    websocket.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);
        handleMessage(msg);
    };
}

function handleMessage(msg) {
    switch (msg.event) {
        case "willAppear":
            onWillAppear(msg);
            break;
        case "willDisappear":
            onWillDisappear(msg);
            break;

        case "dialRotate":
            onDialRotate(msg);
            break;
        case "dialDown":
        case "dialPress":
            onDialPress(msg);
            break;

        case "keyDown":
            onKeyDown(msg);
            break;
    }
}

function getTimer(ctx) {
    if (!timers[ctx]) {
        timers[ctx] = {
            durationSeconds: 60,
            remainingSeconds: 60,
            running: false,
            endTime: null,
            timeoutId: null
        };
    }
    return timers[ctx];
}

function clearTimerTimeout(ctx) {
    const t = timers[ctx];
    if (!t) return;
    if (t.timeoutId) {
        clearTimeout(t.timeoutId);
        t.timeoutId = null;
    }
}

// ───────── lifecycle ─────────

function onWillAppear(msg) {
    const ctx = msg.context;
    getTimer(ctx); // ensure it exists

    // Use our custom layout JSON file
    websocket.send(JSON.stringify({
        event: "setFeedbackLayout",
        context: ctx,
        payload: {
            layout: "Layouts/timerLayout.json"
        }
    }));

    updateDisplay(ctx);
}

function onWillDisappear(msg) {
    const ctx = msg.context;
    clearTimerTimeout(ctx);
    delete timers[ctx];
}

// ───────── dial / key input ─────────

function onDialRotate(msg) {
    const ctx = msg.context;
    const t = getTimer(ctx);
    const ticks = msg.payload.ticks || 0;

    // Only allow changing duration while paused
    if (!t.running) {
        t.durationSeconds += ticks;
        if (t.durationSeconds < 1) t.durationSeconds = 1;

        // Reset remaining to new duration
        t.remainingSeconds = t.durationSeconds;
        t.endTime = null;
    }

    updateDisplay(ctx);
}

function onDialPress(msg) {
    const ctx = msg.context;
    toggleTimer(ctx);
}

function onKeyDown(msg) {
    const ctx = msg.context;
    toggleTimer(ctx);
}

// ───────── timer control ─────────

function toggleTimer(ctx) {
    const t = getTimer(ctx);

    if (t.running) {
        // Pause
        t.running = false;

        // Recompute remaining based on endTime before clearing it
        if (t.endTime !== null) {
            const now = Date.now();
            const msLeft = t.endTime - now;
            t.remainingSeconds = msLeft > 0 ? Math.ceil(msLeft / 1000) : 0;
        }

        t.endTime = null;
        clearTimerTimeout(ctx);
        updateDisplay(ctx);
        return;
    }

    // Start / restart
    if (t.remainingSeconds <= 0) {
        // If timer is at 0, restart from duration
        t.remainingSeconds = t.durationSeconds;
    }

    t.running = true;
    const now = Date.now();
    t.endTime = now + t.remainingSeconds * 1000;

    clearTimerTimeout(ctx);
    scheduleTick(ctx);
    updateDisplay(ctx);
}

function scheduleTick(ctx) {
    const t = timers[ctx];
    if (!t || !t.running || t.endTime === null) return;

    clearTimerTimeout(ctx);

    const now = Date.now();
    const msLeft = t.endTime - now;

    if (msLeft <= 0) {
        // Finish immediately
        finishTimer(ctx);
        return;
    }

    const nextTickMs = Math.min(250, msLeft); // tick up to 4x/sec for smoother bar
    t.timeoutId = setTimeout(() => tick(ctx), nextTickMs);
}

function tick(ctx) {
    const t = timers[ctx];
    if (!t || !t.running || t.endTime === null) return;

    const now = Date.now();
    const msLeft = t.endTime - now;

    if (msLeft <= 0) {
        finishTimer(ctx);
        return;
    }

    t.remainingSeconds = Math.ceil(msLeft / 1000);
    updateDisplay(ctx);
    scheduleTick(ctx);
}

function finishTimer(ctx) {
    const t = timers[ctx];
    if (!t) return;

    t.running = false;
    t.remainingSeconds = 0;
    t.endTime = null;
    clearTimerTimeout(ctx);
    updateDisplay(ctx);

    websocket.send(JSON.stringify({
        event: "showAlert",
        context: ctx
    }));
}

// ───────── UI update ─────────

function updateDisplay(ctx) {
    const t = timers[ctx];
    if (!t) return;

    const mins = Math.floor(t.remainingSeconds / 60);
    const secs = t.remainingSeconds % 60;
    const label = `${mins}:${secs.toString().padStart(2, "0")}`;

    // full bar at start, empty at 0
    let percent = 0;
    if (t.durationSeconds > 0) {
        percent = (t.remainingSeconds / t.durationSeconds) * 100;
    }
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
    percent = Math.round(percent);

    websocket.send(JSON.stringify({
        event: "setFeedback",
        context: ctx,
        payload: {
            title: label,
            progress: percent,                      // 0..100
            status: t.running ? "Running" : "Paused"
        }
    }));

    websocket.send(JSON.stringify({
        event: "setTitle",
        context: ctx,
        payload: {
            title: label
        }
    }));
}
