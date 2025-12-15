import {
    action,
    DialDownEvent,
    DialUpEvent,
    DialRotateEvent,
    DidReceiveSettingsEvent,
    KeyDownEvent,
    KeyUpEvent,
    SendToPluginEvent,
    SingletonAction,
    WillAppearEvent,
    type DialAction,
    type KeyAction,
} from "@elgato/streamdeck";

const TICK_MS = 200;
const TIMER_GROUPS = new Map<string, TimerGroup>();
const ACTION_GROUPS = new Map<string, string>();
const DEFAULT_GROUP_ID = "1"
const HOLD_DELAY_MS = 350;   // how long before it counts as “hold”
const HOLD_REPEAT_MS = 120;  // repeat rate while held (optional)
const HOLD_STATES = new Map<string, HoldState>(); // actionId -> state
const KEY_STATES = new Map<string, number>();

type HoldState = {
    timeout?: number;
    interval?: number;
    firedHold?: boolean;
  };

type TimerSettings = {
    /** color of the bar */
    barFillColor?: string;
    barBgColor?: string;
    barOutlineColor?: string;

    /** this instance's role in the group */
    role?: "dial" | "key";
    /** logical group id that links dial + key */
    groupId?: string;

    /** what this action shows (for both dial and key) */
    displayPart?: "full" | "hours" | "minutes" | "seconds" | "status" | "none" ;

    /** whether to show the progress bar on dials */
    showProgressBar?: boolean;

    /** how many seconds per dial tick */
    incrementSeconds?: number;
    
    // key controls
    pressAction?: "none" | "toggle" | "reset" | "inc" | "dec";
    pressStepSeconds?: number;
    holdAction?: "none" | "toggle" | "reset" | "inc" | "dec";
    holdStepSeconds?: number;
};

type TimerRuntime = {
    id: string;                 // groupId
    durationMs: number;
    remainingMs: number;
    running: boolean;
    finished: boolean;
    startedAt?: number;
    tickHandle?: number;        // 👈 NEW: interval handle
};

/** One group = one shared timer + N dials + N keys */
type TimerGroup = {
    runtime: TimerRuntime;
    dials: DialAction[]; // all dials; each decides its own displayPart
    keys: KeyAction[]; // all keys; each decides its own displayPart
    updateVersion?: number; // track update versions to skip stale updates
    dialLayouts?: Map<string, string>; // cache last layout used per dial to avoid unnecessary layout updates
    lastSettings?: Map<string, TimerSettings>; // cache last settings per action to detect actual changes
};


// helpers
function getStatusState(runtime: TimerRuntime): number {
    // manifest: 0 blank, 1 paused, 2 running
    return runtime.running ? 1 : 0;
  }

function clearHold(actionId: string) {
    const st = HOLD_STATES.get(actionId);
    if (!st) return;
  
    if (st.timeout != null) clearTimeout(st.timeout);
    if (st.interval != null) clearInterval(st.interval);
  
    HOLD_STATES.delete(actionId);
  }
  
function detachFromGroup(groupId: string, actionId: string) {
    const g = TIMER_GROUPS.get(groupId);
    if (!g) return;

    g.dials = g.dials.filter(a => a.id !== actionId);
    g.keys  = g.keys.filter(a => a.id !== actionId);

    // Clear caches tied to this action
    g.dialLayouts?.delete(actionId);
    g.lastSettings?.delete(actionId);

    // Optional cleanup
    if (g.dials.length === 0 && g.keys.length === 0) {
        stopTick(g.runtime);
        TIMER_GROUPS.delete(groupId);
    }
}



function stopTick(runtime: TimerRuntime) {
    if (runtime.tickHandle != null) {
        clearInterval(runtime.tickHandle);
        runtime.tickHandle = undefined;
    }
}

function startTick(groupId: string, group: TimerGroup) {
    const runtime = group.runtime;

    // Already ticking?
    if (runtime.tickHandle != null) return;

    runtime.tickHandle = setInterval(async () => {
        const now = Date.now();

        if (!runtime.running || runtime.startedAt == null) {
            return; // paused or not started; keep interval but do nothing
        }

        const elapsed = now - runtime.startedAt;
        const remaining = Math.max(0, runtime.durationMs - elapsed);
        runtime.remainingMs = remaining;

        if (remaining <= 0 && !runtime.finished) {
            runtime.running = false;
            runtime.finished = true;
            runtime.startedAt = undefined;

            // Pick any action we have to show alert
            const groupRef = TIMER_GROUPS.get(groupId);
            if (groupRef) {
                const actionForAlert =
                    (groupRef.dials[0] as any) ??
                    (groupRef.keys[0] as any);
                try {
                    if (actionForAlert?.showAlert) {
                        await actionForAlert.showAlert();
                    }
                } catch {
                    // ignore
                }
            }

            // Timer done; you *can* stop ticking here if you want:
            // stopTick(runtime);
        }

        try {
            await updateGroupUI(groupId);
        } catch {
            // ignore UI errors
        }
    }, TICK_MS) as unknown as number;
}

let tickStarted = false;

function formatLabel(remainingMs: number): string {
    const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function splitTime(remainingMs: number) {
    const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return {
        hours,
        minutes,
        seconds,
        hh: hours.toString().padStart(2, "0"),
        mm: minutes.toString().padStart(2, "0"),
        ss: seconds.toString().padStart(2, "0"),
    };
}

async function updateGroupUI(groupId: string, updateVersion?: number) {
    const group = TIMER_GROUPS.get(groupId);
    if (!group) return;

    // If an update version is provided, check if this update is still current
    if (updateVersion != null && group.updateVersion != null && updateVersion < group.updateVersion) {
        // This update is stale, skip it
        return;
    }

    const { runtime, dials, keys } = group;
    const labelFull = formatLabel(runtime.remainingMs);
    const { hh, mm, ss } = splitTime(runtime.remainingMs);

    const ratio =
        runtime.durationMs > 0 ? runtime.remainingMs / runtime.durationMs : 0;
    const percent = Math.round(Math.max(0, Math.min(100, ratio * 100)));

    // Update all dials in parallel, each with its own displayPart, progress bar setting, and colors
    const dialUpdatePromises = dials.map(async (dial) => {
        try {
            const dialSettings = await dial.getSettings() as TimerSettings;
            const dialDisplayPart = dialSettings.displayPart ?? "full";
            const showProgressBar = dialSettings.showProgressBar !== false; // default to true
            // Each dial uses its own colors
            const fill = dialSettings.barFillColor ?? "#FFFFFF";
            const bg = dialSettings.barBgColor ?? "#000000";
            const outline = dialSettings.barOutlineColor;
            
            // Ensure layout is set correctly based on showProgressBar setting
            // Only update layout if it changed to avoid unnecessary work
            const layoutPath = showProgressBar 
                ? "layouts/custom-layout-5.json" 
                : "layouts/custom-layout-6.json";
            
            // Cache layouts to avoid unnecessary layout updates
            if (!group.dialLayouts) {
                group.dialLayouts = new Map();
            }
            const lastLayout = group.dialLayouts.get(dial.id);
            if (lastLayout !== layoutPath) {
                await dial.setFeedbackLayout(layoutPath);
                group.dialLayouts.set(dial.id, layoutPath);
            }
            
            let timeValue = "";
            switch (dialDisplayPart) {
                case "none":
                    timeValue = "";
                    break;
                case "hours":
                    timeValue = hh;
                    break;
                case "minutes":
                    timeValue = mm;
                    break;
                case "seconds":
                    timeValue = ss;
                    break;
                case "full":
                default:
                    timeValue = labelFull;
                    break;
            }
            
            // Build feedback object conditionally based on showProgressBar
            const feedback: any = {
                time: { value: timeValue },
            };
            
            // Only include progress if progress bar should be shown
            if (showProgressBar) {
                feedback.progress = {
                    value: percent,
                    bar_fill_c: fill,
                    bar_bg_c: bg,
                    ...(outline && { bar_border_c: outline }),
                };
            }
            
            await dial.setFeedback(feedback);
        } catch (error) {
            // Log error but don't stop other dials from updating
            console.error(`Error updating dial ${dial.id}:`, error);
        }
    });
    
    // Wait for all dial updates to complete
    await Promise.all(dialUpdatePromises);

    // Check again if update is still current after dial updates
    if (updateVersion != null && group.updateVersion != null && updateVersion < group.updateVersion) {
        return;
    }

    // Each key reads its own displayPart from its own settings
    // Update all keys in parallel for better performance and ensure all refresh
    const keyUpdatePromises = keys.map(async (key) => {
        try {
            const keySettings = await key.getSettings() as TimerSettings;
            const displayPart = keySettings.displayPart ?? "full";


            switch (displayPart) {
                case "status": {
                    const nextState = getStatusState(runtime);
                    const lastState = KEY_STATES.get(key.id);
                  
                    if (lastState !== nextState) {
                      await key.setState(nextState);
                      KEY_STATES.set(key.id, nextState);
                    }
                  
                    // IMPORTANT: do NOT touch title here
                    break;
                  }
              
                case "none":
                  // If you want the title to be user-controlled, do nothing here:
                  // (don’t wipe the title)
                  // await key.setTitle("");
                  break;
              
                case "hours":
                  await key.setTitle(hh);
                  break;
              
                case "minutes":
                  await key.setTitle(mm);
                  break;
              
                case "seconds":
                  await key.setTitle(ss);
                  break;
              
                case "full":
                default:
                  await key.setTitle(labelFull);
                  break;
              }
        } catch (error) {
            // Log error but don't stop other keys from updating
            console.error(`Error updating key ${key.id}:`, error);
        }
    });
    
    // Wait for all key updates to complete
    await Promise.all(keyUpdatePromises);
    
    // Mark this update as complete
    if (updateVersion != null) {
        if (group.updateVersion === updateVersion) {
            // This was the latest update, clear the version
            group.updateVersion = undefined;
        }
    }
}

async function toggleTimer(runtime: TimerRuntime, groupId: string) {
    const now = Date.now();

    const group = TIMER_GROUPS.get(groupId);
    if (!group) return;

    if (!runtime.running) {
        // Start or resume
        if (runtime.remainingMs <= 0 || runtime.finished) {
            runtime.remainingMs = runtime.durationMs;
            runtime.finished = false;
        }
        const elapsedAlready = runtime.durationMs - runtime.remainingMs;
        runtime.startedAt = now - elapsedAlready;
        runtime.running = true;

        // Ensure this group's tick is running
        startTick(groupId, group);
    } else {
        // Pause
        if (runtime.startedAt != null) {
            const elapsed = now - runtime.startedAt;
            runtime.remainingMs = Math.max(
                0,
                runtime.durationMs - elapsed,
            );
        }
        runtime.startedAt = undefined;
        runtime.running = false;

        // Optional: stop ticking entirely while paused
        // so it doesn't keep scheduling work
        // (you can leave it running if you prefer)
        // stopTick(runtime);
    }

    await updateGroupUI(groupId);
}


function ensureTickLoop() {
    if (tickStarted) return;
    tickStarted = true;

    setInterval(async () => {
        const now = Date.now();

        for (const [groupId, group] of TIMER_GROUPS.entries()) {
            const runtime = group.runtime;
            if (!runtime.running || runtime.startedAt == null) continue;

            const elapsed = now - runtime.startedAt;
            const remaining = Math.max(0, runtime.durationMs - elapsed);
            runtime.remainingMs = remaining;

            if (remaining <= 0 && !runtime.finished) {
                runtime.running = false;
                runtime.finished = true;
                // ...
            }

            try {
                await updateGroupUI(groupId);
            } catch {
                // ...
            }
        }
    }, TICK_MS);
}

/**
 * Get or create the shared TimerGroup for this event.
 * This links dial + keys via settings.groupId.
 */
function getOrCreateGroup(
    ev:
        | WillAppearEvent<TimerSettings>
        | DialRotateEvent<TimerSettings>
        | DialDownEvent<TimerSettings>
        | KeyDownEvent<TimerSettings>,
): TimerGroup {
    const action = ev.action as DialAction | KeyAction;
    const settings = ev.payload.settings;

    const groupId = settings.groupId || DEFAULT_GROUP_ID;
    const role =
        settings.role ||
        (action.isDial() ? ("dial" as const) : ("key" as const));

    let group = TIMER_GROUPS.get(groupId);

    if (!group) {
        // Use default initial duration (5 minutes) since dial rotation controls the actual duration
        const durationSeconds = 300; // 5 minutes default
        const durationMs = durationSeconds * 1000;

        group = {
            runtime: {
                id: groupId,
                durationMs,
                remainingMs: durationMs,
                running: false,
                finished: false,
            },
            dials: [],
            keys: [],
        };
        TIMER_GROUPS.set(groupId, group);
    }

    const actionId = action.id;
    const newGroupId = settings.groupId || DEFAULT_GROUP_ID;  // pick ONE default and use it everywhere

    const prevGroupId = ACTION_GROUPS.get(actionId);
    if (prevGroupId && prevGroupId !== newGroupId) {
        detachFromGroup(prevGroupId, actionId);
    }
    ACTION_GROUPS.set(actionId, newGroupId);


    // Attach this action based on role
    if (role === "dial" && action.isDial()) {
        const dialAction = action as DialAction;
        // Avoid duplicates
        if (!group.dials.some(d => d.id === dialAction.id)) {
            group.dials.push(dialAction);
        }
    } else if (role === "key" && action.isKey()) {
        const keyAction = action as KeyAction;
        // Avoid duplicates
        if (!group.keys.some(k => k.id === keyAction.id)) {
            group.keys.push(keyAction);
        }
    }

    // Persist inferred role/groupId back, so PI sees them too if blank
    if (!settings.role || !settings.groupId) {
        settings.role = role;
        settings.groupId = groupId;
        void action.setSettings(settings);
    }

    return group;
}


async function handleAction(
    groupId: string,
    group: TimerGroup,
    runtime: TimerRuntime,
    action: "toggle" | "reset" | "inc" | "dec",
    stepSeconds?: number,
  ) {
    let step = Number(stepSeconds ?? 5);
    if (!Number.isFinite(step) || step <= 0) step = 5;
  
    if (action === "toggle") {
      await toggleTimer(runtime, groupId);
      return;
    }
  
    if (action === "reset") {
      runtime.remainingMs = runtime.durationMs;
      runtime.finished = false;
      runtime.startedAt = undefined;
      runtime.running = false;
      await updateGroupUI(groupId);
      return;
    }
  
    // inc/dec – only adjust when paused (keep your current behavior)
    if (runtime.running) return;
  
    const currentSeconds = Math.max(5, Math.round(runtime.durationMs / 1000));
    const delta = action === "inc" ? step : -step;
  
    let newSeconds = currentSeconds + delta;
    const MAX_SECONDS = 24 * 60 * 60;
    newSeconds = Math.min(MAX_SECONDS, Math.max(5, newSeconds));
  
    runtime.durationMs = newSeconds * 1000;
    runtime.remainingMs = runtime.durationMs;
    runtime.finished = false;
    runtime.startedAt = undefined;
  
    group.updateVersion = (group.updateVersion ?? 0) + 1;
    const v = group.updateVersion;
    updateGroupUI(groupId, v).catch(console.error);
  }
  
  async function handleTap(groupId: string, group: TimerGroup, runtime: TimerRuntime, settings: TimerSettings) {
    const a = settings.pressAction ?? "toggle";
    await handleAction(groupId, group, runtime, a as any, settings.pressStepSeconds);
  }
  
  
  async function handleHold(groupId: string, group: TimerGroup, runtime: TimerRuntime, settings: TimerSettings) {
    const a = settings.holdAction ?? "none";
    if (a === "none") return;
  
    await handleAction(groupId, group, runtime, a as any, settings.holdStepSeconds);
  }
  
/**
 * NEW action: TimerController
 * - Place on a dial to control a timer for a matching groupId.
 * - Place on keys (same groupId) with displayPart = full/hours/minutes/seconds.
 */
@action({ UUID: "com.jonathan-smith.streamdeck-timer-plugin.timer-controller" })
export class TimerControllerAction extends SingletonAction<TimerSettings> {
    override async onWillAppear(
        ev: WillAppearEvent<TimerSettings>,
    ): Promise<void> {
        const group = getOrCreateGroup(ev);
        const runtime = group.runtime;
    
        const settings = ev.payload.settings;
    
        // Ensure some sane defaults for new instances
        if (!settings.incrementSeconds || Number(settings.incrementSeconds) <= 0) {
            settings.incrementSeconds = 5;
        }
        if (!settings.groupId) {
            settings.groupId = runtime.id;
        }
        if (!settings.role) {
            settings.role = ev.action.isDial() ? "dial" : "key";
        }
    
        // Set the layout for dials based on showProgressBar setting
        if (ev.action.isDial()) {
            const showProgressBar = settings.showProgressBar !== false; // default to true
            const layoutPath = showProgressBar 
                ? "layouts/custom-layout-5.json" 
                : "layouts/custom-layout-6.json";
            await ev.action.setFeedbackLayout(layoutPath);
            
            // Cache the layout
            if (!group.dialLayouts) {
                group.dialLayouts = new Map();
            }
            group.dialLayouts.set(ev.action.id, layoutPath);
        }
        
        // Cache initial settings to detect changes later
        if (!group.lastSettings) {
            group.lastSettings = new Map();
        }
        group.lastSettings.set(ev.action.id, { ...settings });

        // 👇 DO NOT set runtime.durationMs / remainingMs from settings here
        // That's what causes "it goes back to an old timer" feelings.

        // If you still want the PI to show something sane for durationSeconds:
        // settings.durationSeconds = Math.round(runtime.durationMs / 1000);
        // await ev.action.setSettings(settings);

        await updateGroupUI(settings.groupId || DEFAULT_GROUP_ID);
    }


    override async onDialRotate(
        ev: DialRotateEvent<TimerSettings>,
    ): Promise<void> {
        const group = getOrCreateGroup(ev);
        const runtime = group.runtime;
    
        // Only adjust when paused
        if (runtime.running) return;
    
        const ticks = ev.payload.ticks ?? 0;
        if (!ticks) return;
    
        const settings = ev.payload.settings;
    
        // Per-instance increment
        let increment = Number(settings.incrementSeconds);
        if (!Number.isFinite(increment) || increment <= 0) {
            increment = 5; // default tick size
        }
    
        // 🔑 Base on shared runtime, not settings
        const currentSeconds = Math.max(5, Math.round(runtime.durationMs / 1000));
    
        let newSeconds = currentSeconds + ticks * increment;
    
        // Clamp however you like
        const MAX_SECONDS = 24 * 60 * 60; // 24h, tweak if you want
        newSeconds = Math.min(MAX_SECONDS, Math.max(5, newSeconds));
    
        // Update shared runtime only
        runtime.durationMs = newSeconds * 1000;
        runtime.remainingMs = runtime.durationMs;
        runtime.finished = false;
        runtime.startedAt = undefined;
    
        // 👇 OPTIONAL: if you *really* want PI to show current duration,
        // you can keep this. If you want to eliminate all weirdness, you can remove it.
        // settings.durationSeconds = newSeconds;
        // await ev.action.setSettings(settings);
    
        // Increment update version to mark this as the latest update
        group.updateVersion = (group.updateVersion ?? 0) + 1;
        const thisUpdateVersion = group.updateVersion;
    
        // Fire off update immediately without blocking - this allows rapid updates
        // Stale updates will be skipped automatically
        updateGroupUI(runtime.id, thisUpdateVersion).catch(error => {
            console.error(`Error updating group UI for ${runtime.id}:`, error);
        });
    }

    override async onDialDown(ev: DialDownEvent<TimerSettings>): Promise<void> {
        const actionId = ev.action.id;
        clearHold(actionId);
      
        const group = getOrCreateGroup(ev);
        const runtime = group.runtime;
        const settings = ev.payload.settings;
        const groupId = settings.groupId || DEFAULT_GROUP_ID;
      
        const st: HoldState = { firedHold: false };
        HOLD_STATES.set(actionId, st);
      
        st.timeout = setTimeout(() => {
          st.firedHold = true;
      
          // Fire hold once
          handleHold(groupId, group, runtime, settings).catch(console.error);
      
          // Repeat only for inc/dec
          const ha = settings.holdAction ?? "none";
          if (ha === "inc" || ha === "dec") {
            st.interval = setInterval(() => {
              handleHold(groupId, group, runtime, settings).catch(console.error);
            }, HOLD_REPEAT_MS) as unknown as number;
          }
        }, HOLD_DELAY_MS) as unknown as number;
      }
      
      override async onDialUp(ev: DialUpEvent<TimerSettings>): Promise<void> {
        const actionId = ev.action.id;
        const st = HOLD_STATES.get(actionId);
      
        clearHold(actionId);
      
        // If hold never fired, treat as a tap
        if (!st?.firedHold) {
          const group = getOrCreateGroup(ev as any);
          const runtime = group.runtime;
          const settings = (ev as any).payload.settings as TimerSettings;
          const groupId = settings.groupId || DEFAULT_GROUP_ID;
      
          await handleTap(groupId, group, runtime, settings);
        }
      }
      
    override async onKeyDown(ev: KeyDownEvent<TimerSettings>): Promise<void> {
        const actionId = ev.action.id;
        clearHold(actionId);
      
        const group = getOrCreateGroup(ev);
        const runtime = group.runtime;
        const settings = ev.payload.settings;
        const groupId = settings.groupId || DEFAULT_GROUP_ID;
      
        const st: HoldState = { firedHold: false };
        HOLD_STATES.set(actionId, st);
      
        st.timeout = setTimeout(() => {
          st.firedHold = true;
      
          // fire hold once immediately
          handleHold(groupId, group, runtime, settings).catch(console.error);
      
          // optional repeat while held:
          const holdAction = settings.holdAction ?? "none";
          if (holdAction === "inc" || holdAction === "dec") {
            st.interval = setInterval(() => {
              handleHold(groupId, group, runtime, settings).catch(console.error);
            }, HOLD_REPEAT_MS) as unknown as number;
          }
        }, HOLD_DELAY_MS) as unknown as number;
      }
      
      override async onKeyUp(ev: KeyUpEvent<TimerSettings>): Promise<void> {
        const actionId = ev.action.id;
        const st = HOLD_STATES.get(actionId);
      
        clearHold(actionId);
      
        // If hold never fired, treat as tap
        if (!st?.firedHold) {
          const group = getOrCreateGroup(ev as any);
          const runtime = group.runtime;
          const settings = (ev as any).payload.settings as TimerSettings;
          const groupId = settings.groupId || DEFAULT_GROUP_ID;
      
          await handleTap(groupId, group, runtime, settings);
        }
      }
      

    override async onDidReceiveSettings(
        ev: DidReceiveSettingsEvent<TimerSettings>,
    ): Promise<void> {
        // When settings change, update the UI immediately
        const settings = ev.payload.settings;
        const groupId = settings.groupId || DEFAULT_GROUP_ID;
        
        // Update the group to ensure the action is registered
        const group = getOrCreateGroup({
            action: ev.action,
            payload: { settings }
        } as any);
        
        // Check if settings actually changed (avoid updates during initialization)
        if (!group.lastSettings) {
            group.lastSettings = new Map();
        }
        
        const lastSettings = group.lastSettings.get(ev.action.id);
        const settingsChanged = !lastSettings ||
        lastSettings.groupId !== settings.groupId ||
        lastSettings.role !== settings.role ||
        lastSettings.displayPart !== settings.displayPart ||
        lastSettings.showProgressBar !== settings.showProgressBar ||
        lastSettings.barFillColor !== settings.barFillColor ||
        lastSettings.barBgColor !== settings.barBgColor ||
        lastSettings.barOutlineColor !== settings.barOutlineColor ||
        lastSettings.pressAction !== settings.pressAction ||
        lastSettings.pressStepSeconds !== settings.pressStepSeconds ||
        lastSettings.incrementSeconds !== settings.incrementSeconds;
        
        
        // Only update if settings actually changed
        if (!settingsChanged) {
            // Update cache but don't refresh UI
            group.lastSettings.set(ev.action.id, { ...settings });
            return;
        }
        
        // Update cache
        group.lastSettings.set(ev.action.id, { ...settings });
        
        // If this is a dial, update the layout if showProgressBar or displayPart changed
        if (ev.action.isDial()) {
            const showProgressBar = settings.showProgressBar !== false; // default to true
            const layoutPath = showProgressBar 
                ? "layouts/custom-layout-5.json" 
                : "layouts/custom-layout-6.json";
            
            // Clear the cached layout so it updates
            if (group.dialLayouts) {
                const oldLayout = group.dialLayouts.get(ev.action.id);
                if (oldLayout !== layoutPath) {
                    group.dialLayouts.delete(ev.action.id);
                    await ev.action.setFeedbackLayout(layoutPath);
                }
            } else {
                await ev.action.setFeedbackLayout(layoutPath);
            }
        }

        const prevDisplayPart = lastSettings?.displayPart;
        const nextDisplayPart = settings.displayPart;

        // If we’re entering or leaving status mode, invalidate cached key state
        if (ev.action.isKey() && prevDisplayPart !== nextDisplayPart) {
        KEY_STATES.delete(ev.action.id);
        }

        
        // Trigger UI update for the entire group
        await updateGroupUI(groupId);
    }

    override async onSendToPlugin(
        ev: SendToPluginEvent<any, TimerSettings>,
    ): Promise<void> {
        // Handle live updates from Property Inspector (like color changes)
        const payload = ev.payload;
        
        if (payload.liveBarUpdate) {
            // Update colors and refresh UI
            const settings = await ev.action.getSettings() as TimerSettings;
            if (payload.barFillColor) {
                settings.barFillColor = payload.barFillColor;
            }
            if (payload.barBgColor) {
                settings.barBgColor = payload.barBgColor;
            }
            if (payload.barOutlineColor !== undefined) {
                settings.barOutlineColor = payload.barOutlineColor;
            }
            await ev.action.setSettings(settings);
            
            // Update the group UI immediately
            const groupId = settings.groupId || DEFAULT_GROUP_ID;
            await updateGroupUI(groupId);
        }
    }
}
