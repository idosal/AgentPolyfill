//! Terminal input translated to CDP, including synthetic releases for held
//! arrows, native-select avoidance, and scrolled host-page coordinates.
use std::sync::atomic::Ordering;
use anyhow::Result;
use serde_json::{Value, json};
use crate::views::{View, Held, Press, now, num, string};

const MULTI_CLICK_MS: u64 = 500;
const MULTI_CLICK_PX: f64 = 6.0;
const HOLD_FIRST_MS: u64 = 150;
const HOLD_REPEAT_MS: u64 = 160;
const HOVER_REST_MS: u64 = 90;
const HOVER_SWEEP_MS: u64 = 300;

pub fn key_name(key: &str) -> String {
    let name = match key {
        "up"=>"ArrowUp", "down"=>"ArrowDown", "left"=>"ArrowLeft", "right"=>"ArrowRight",
        "return"|"enter"=>"Enter", "tab"=>"Tab", "backspace"=>"Backspace", "delete"=>"Delete",
        "pageup"=>"PageUp", "pagedown"=>"PageDown", "home"=>"Home", "end"=>"End", "space"=>" ",
        "escape"=>"Escape", "insert"=>"Insert",
        "\x1bOP"|"\x1b[11~"=>"F1", "\x1bOQ"|"\x1b[12~"=>"F2", "\x1bOR"|"\x1b[13~"=>"F3", "\x1bOS"|"\x1b[14~"=>"F4",
        "\x1b[15~"=>"F5", "\x1b[17~"=>"F6", "\x1b[18~"=>"F7", "\x1b[19~"=>"F8", "\x1b[20~"=>"F9",
        "\x1b[21~"=>"F10", "\x1b[23~"=>"F11", "\x1b[24~"=>"F12", "\x1b[2~"=>"Insert",
        _=>key,
    };
    if let Some(n) = name.strip_prefix('f').and_then(|s|s.parse::<u8>().ok()).filter(|n|(1..=12).contains(n)) { format!("F{n}") }
    else { name.into() }
}

pub fn is_key_name(name: &str) -> bool {
    matches!(name,"ArrowUp"|"ArrowDown"|"ArrowLeft"|"ArrowRight"|"Enter"|"Tab"|"Backspace"|"Delete"|"PageUp"|"PageDown"|"Home"|"End"|" "|"Escape"|"Insert") ||
        name.strip_prefix('F').and_then(|s|s.parse::<u8>().ok()).is_some_and(|n|(1..=12).contains(&n) && name == format!("F{n}"))
}

fn definition(name: &str) -> (String,u32) {
    let (code, vk) = match name {
        "Backspace"=>("Backspace",8),"Tab"=>("Tab",9),"Enter"=>("Enter",13),
        "Shift"=>("ShiftLeft",16),"Control"=>("ControlLeft",17),"Alt"=>("AltLeft",18),"Meta"=>("MetaLeft",91),
        "Escape"=>("Escape",27)," "=>("Space",32),"PageUp"=>("PageUp",33),"PageDown"=>("PageDown",34),
        "End"=>("End",35),"Home"=>("Home",36),"ArrowLeft"=>("ArrowLeft",37),"ArrowUp"=>("ArrowUp",38),
        "ArrowRight"=>("ArrowRight",39),"ArrowDown"=>("ArrowDown",40),"Insert"=>("Insert",45),"Delete"=>("Delete",46),
        ";"|":"=>("Semicolon",186),"="|"+"=>("Equal",187),","|"<"=>("Comma",188),"-"|"_"=>("Minus",189),
        "."|">"=>("Period",190),"/"|"?"=>("Slash",191),"`"|"~"=>("Backquote",192),
        "["|"{"=>("BracketLeft",219),"\\"|"|"=>("Backslash",220),"]"|"}"=>("BracketRight",221),"'"|"\""=>("Quote",222),
        _=>("",0),
    };
    if vk != 0 { return (code.into(),vk); }
    if let Some(n) = name.strip_prefix('F').and_then(|s|s.parse::<u32>().ok()).filter(|n|(1..=12).contains(n)) { return (name.into(),111+n); }
    if name.len() == 1 {
        let c = name.as_bytes()[0];
        if c.is_ascii_alphabetic() { return (format!("Key{}",(c as char).to_ascii_uppercase()),u32::from(c.to_ascii_uppercase())); }
        if c.is_ascii_digit() { return (format!("Digit{}",c as char),u32::from(c)); }
        if let Some(n) = ")!@#$%^&*(".find(c as char) { return (format!("Digit{n}"),48+n as u32); }
    }
    (String::new(),0)
}

fn modifier(name: &str) -> u32 { match name { "Alt"=>1,"Control"=>2,"Meta"=>4,"Shift"=>8,_=>0 } }
fn buttons(button: &str) -> u32 { match button { "left"=>1,"right"=>2,"middle"=>4,"back"=>8,"forward"=>16,_=>0 } }

fn key_input(event: &Value) -> (&str, String, Vec<String>) {
    let key = string(event, "key");
    let name = key_name(key);
    let mut mods = Vec::new();
    if event["ctrl"] == true { mods.push("Control".into()); }
    if event["meta"] == true { mods.push("Meta".into()); }
    if event["shift"] == true && name.encode_utf16().count() > 1 { mods.push("Shift".into()); }
    (key, name, mods)
}

#[derive(Debug)]
struct Pointer {
    x: f64,
    y: f64,
    vy: f64,
    fx: f64,
    fy: f64,
}

fn pointer_coordinates(event: &Value, cell_h: f64, top: f64, scale: f64, at: f64) -> Result<Pointer> {
    let x = num(&event["fine"], "x", num(event, "x", 0.0) + 0.5) * 8.0;
    let y = num(&event["fine"], "y", num(event, "y", 0.0) + 0.5) * cell_h;
    let doc_y = y + top;
    let vy = doc_y - at;
    let fx = x / scale;
    let fy = doc_y / scale;
    // Chrome ultimately uses signed pixel coordinates. Refuse overflow before
    // it becomes JSON null or an Infinity literal in elementFromPoint's JS.
    if [x, y, doc_y, vy, fx, fy].iter().any(|n| !n.is_finite() || !(f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(n)) {
        anyhow::bail!("pointer coordinates out of range");
    }
    Ok(Pointer { x, y, vy, fx, fy })
}

impl View {
    async fn key_event(&self, name: &str, down: bool, modifiers: u32) -> Result<()> {
        let (code,vk) = definition(name);
        let text = if down && modifiers & !8 == 0 {
            if name == "Enter" { "\r" } else if name.chars().count() == 1 { name } else { "" }
        } else { "" };
        self.page.send("Input.dispatchKeyEvent",json!({
            "type":if down {if text.is_empty() {"rawKeyDown"} else {"keyDown"}} else {"keyUp"},
            "key":name,"code":code,"windowsVirtualKeyCode":vk,"text":text,"unmodifiedText":text,
            "modifiers":modifiers,"location":if matches!(name,"Control"|"Shift"|"Alt"|"Meta") {1} else {0},
        })).await?;
        Ok(())
    }

    async fn press_key(&self, name: &str, mods: &[String]) -> Result<()> {
        let mut mask = 0;
        for m in mods { mask |= modifier(m); self.key_event(m,true,mask).await?; }
        self.key_event(name,true,mask).await?;
        self.key_event(name,false,mask).await?;
        for m in mods.iter().rev() { mask &= !modifier(m); self.key_event(m,false,mask).await?; }
        Ok(())
    }

    async fn hold_key(&self, name: &str, mods: Vec<String>) -> Result<()> {
        {
            let mut s = self.state.lock().unwrap();
            if let Some(held) = s.held.get_mut(name) { held.until = now()+HOLD_REPEAT_MS; return Ok(()); }
        }
        let mut mask = 0;
        for m in &mods { mask |= modifier(m); self.key_event(m,true,mask).await?; }
        self.key_event(name,true,mask).await?;
        self.state.lock().unwrap().held.insert(name.into(),Held {mods,until:now()+HOLD_FIRST_MS});
        self.capture_soon(50); // also wakes the timer queue for its release
        Ok(())
    }

    pub async fn release_key(&self, name: &str) {
        let _input = self.inputs.lock().await;
        let held = {
            let mut s = self.state.lock().unwrap();
            if s.held.get(name).is_none_or(|h|h.until > now()) { return; }
            s.held.remove(name).unwrap()
        };
        let mut mask = held.mods.iter().fold(0,|mask,m|mask|modifier(m));
        let _ = self.key_event(name,false,mask).await;
        for m in held.mods.iter().rev() { mask &= !modifier(m); let _ = self.key_event(m,false,mask).await; }
    }

    async fn mouse_move(&self, x: f64, y: f64) -> Result<()> {
        let held = { let mut s = self.state.lock().unwrap(); s.mouse=(x,y); s.buttons };
        self.page.send("Input.dispatchMouseEvent",json!({"type":"mouseMoved","x":x,"y":y,"buttons":held,
            "button":if held&1!=0 {"left"} else if held&2!=0 {"right"} else if held&4!=0 {"middle"} else {"none"}})).await?;
        Ok(())
    }

    pub async fn input_event(&self, event: &Value) -> Result<()> {
        let _input = self.inputs.lock().await;
        if !self.alive.load(Ordering::SeqCst) { return Ok(()); }
        // Wait for Chrome to restore hit-testing after a screenshot (View::shoot).
        let _gate = match string(event, "kind") {
            "pointer" | "wheel" => Some(self.pointer_gate.write().await),
            _ => None,
        };
        match string(event,"kind") {
            "pointer" => {
                let (cell_h,top,scale,image) = { let s = self.state.lock().unwrap(); (s.cell_h,s.scroll,s.scale,s.image) };
                let at = if top != 0.0 {self.page_scroll().await} else {0.0};
                let Pointer { x, mut y, mut vy, fx, mut fy } = pointer_coordinates(event,cell_h,top,scale,at)?;
                if !image {
                    // A text line grouping drew on another row (lines.rs): a
                    // pointer on it goes where the text is on the page.
                    let col = num(&event["fine"], "x", num(event, "x", 0.0)).floor() as i64;
                    let row = num(&event["fine"], "y", num(event, "y", 0.0)).floor() as i64;
                    let (shift, snapped) = { let s = self.state.lock().unwrap(); (crate::lines::shift_at(&s.moved, col, row), s.snapped.clone()) };
                    if let Some(rows) = shift { let by = rows as f64 * cell_h; y -= by; vy -= by; fy -= by / scale; }
                    // Then the row snap (snap.rs), which came before grouping.
                    if let Some((snap, per)) = snapped {
                        let drawn = y * per;
                        let by = drawn - snap.unmap(drawn);
                        let by = by / per;
                        y -= by; vy -= by; fy -= by / scale;
                    }
                }
                let button = event["button"].as_str().unwrap_or("left");
                let kind = string(event,"type");
                if matches!(kind,"down"|"up") && button == "left" {
                    let select = self.page.app_eval_input(&format!("(() => {{const s=document.elementFromPoint({fx},{fy})?.closest('select'); if(!s||s.disabled)return false; s.focus(); return true;}})()")).await?;
                    if select == true { self.capture_soon(50); return Ok(()); }
                }
                match kind {
                    "down" => {
                        // When the press reached the helper (views.rs, "/input"), not when its turn came.
                        let at = event["receivedAt"].as_u64().unwrap_or_else(now);
                        let count = {
                            let mut s = self.state.lock().unwrap(); s.pointer_held=true;
                            let count = s.last_press.as_ref().filter(|last|last.button==button && at.saturating_sub(last.at)<MULTI_CLICK_MS && (x-last.x).hypot(y-last.y)<=MULTI_CLICK_PX)
                                .map_or(1,|last|(last.count+1).min(3));
                            s.last_press=Some(Press {at,x,y,button:button.into(),count}); count
                        };
                        self.mouse_move(x,vy).await?;
                        let held = { let mut s = self.state.lock().unwrap(); s.buttons|=buttons(button); s.buttons };
                        self.page.send("Input.dispatchMouseEvent",json!({"type":"mousePressed","x":x,"y":vy,"button":button,"buttons":held,"clickCount":count})).await?;
                    }
                    "up" => {
                        self.mouse_move(x,vy).await?;
                        let (held,count) = {
                            let mut s=self.state.lock().unwrap(); s.pointer_held=false; s.buttons&=!buttons(button);
                            (s.buttons,s.last_press.as_ref().map_or(1,|p|p.count))
                        };
                        self.page.send("Input.dispatchMouseEvent",json!({"type":"mouseReleased","x":x,"y":vy,"button":button,"buttons":held,"clickCount":count})).await?;
                        if image { self.capture_soon(HOVER_REST_MS+10); }
                    }
                    "move" => {
                        self.mouse_move(x,vy).await?;
                        if event["button"].is_null() && image {
                            let held = {
                                let mut s=self.state.lock().unwrap(); let time=now();
                                if time.saturating_sub(s.hover_at)>1000 {s.hold_for_rest=time.saturating_sub(s.idle_change_at)>1500;}
                                s.hover_at=time;
                                if s.hold_for_rest {
                                    if s.rest_until<=time {s.held_since=time.saturating_sub(HOVER_SWEEP_MS);}
                                    s.rest_until=time+HOVER_REST_MS;
                                    if time.saturating_sub(s.held_since)>=HOVER_SWEEP_MS {s.held_since=time;s.sweep=true;}
                                }
                                s.hold_for_rest
                            };
                            if held {
                                self.capture_soon(HOVER_REST_MS+10);
                                let sweep=self.state.lock().unwrap().sweep;
                                if sweep {self.capture_soon(0);}
                                return Ok(());
                            }
                        }
                    }
                    _ => {}
                }
            }
            "wheel" => {
                let (x,y,cell_h) = {let s=self.state.lock().unwrap();(s.mouse.0,s.mouse.1,s.cell_h)};
                self.page.send("Input.dispatchMouseEvent",json!({"type":"mouseWheel","x":x,"y":y,"deltaX":0,"deltaY":num(event,"by",0.0)*3.0*cell_h})).await?;
            }
            "key" => {
                let (key,name,mods)=key_input(event);
                let scroll = {
                    let mut s=self.state.lock().unwrap();
                    if matches!(key,"pagedown"|"pageup") && s.height>f64::from(s.max_rows)*s.cell_h {
                        s.scroll += if key=="pagedown" {1.0} else {-1.0} * f64::from(s.max_rows-2)*s.cell_h;
                        s.generation += 1;
                        true
                    } else {false}
                };
                if scroll {
                    let _turn=self.turn.lock().await; self.clamp_scroll().await?; self.capture_soon(10); return Ok(());
                }
                let handled=self.page.app_eval_input(&format!(r#"((key)=>{{
                    const select=document.activeElement;
                    if(!(select instanceof HTMLSelectElement))return false;
                    const step=key==='up'||key==='left'?-1:key==='down'||key==='right'?1:0;
                    if(!step)return key==='return'||key==='space'||key===' ';
                    let index=select.selectedIndex;
                    do index+=step; while(index>=0&&index<select.options.length&&select.options[index].disabled);
                    if(index<0||index>=select.options.length)return true;
                    select.selectedIndex=index;
                    select.dispatchEvent(new Event('input',{{bubbles:true}}));
                    select.dispatchEvent(new Event('change',{{bubbles:true}}));return true;
                }})({})"#,json!(key))).await?;
                if handled==true {self.capture_soon(50);self.capture_soon(300);return Ok(());}
                let arrow=matches!(name.as_str(),"ArrowUp"|"ArrowDown"|"ArrowLeft"|"ArrowRight");
                let editable=if arrow {
                    self.page.app_eval("(() => {const el=document.activeElement;return Boolean(el&&(el.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));})()").await.unwrap_or(json!(false))==true
                } else {false};
                if arrow && !editable {self.hold_key(&name,mods).await?;}
                else if (name.chars().count()==1 && (!mods.is_empty() || name.is_ascii())) || is_key_name(&name) {
                    self.press_key(&name,&mods).await?;
                } else if name.chars().any(|c|matches!(c,'\u{0000}'..='\u{001f}'|'\u{007f}')) {
                    crate::out::log(format!("key {:?}: not a key we know, dropped",name));
                } else {self.page.send("Input.insertText",json!({"text":name})).await?;}
            }
            _ => {}
        }
        self.capture_soon(50);self.capture_soon(250);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::test_support::cases;

    fn check_event(event: &Value) {
        let (_, name, mods) = key_input(event);
        let _ = is_key_name(&name);
        let (_, vk) = definition(&name);
        assert!(vk <= 222);
        assert!(mods.iter().all(|m| matches!(m.as_str(), "Control" | "Meta" | "Shift")));
        assert!(mods.iter().fold(0, |mask, m| mask | modifier(m)) <= 15);
        let _ = buttons(event["button"].as_str().unwrap_or("left"));
        if let Ok(point) = pointer_coordinates(event, 16.0, 512.0, 1.25, 256.0) {
            for value in [point.x, point.y, point.vy, point.fx, point.fy] {
                assert!(value.is_finite() && (f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(&value), "{event}: {point:?}");
            }
        }
    }

    #[test]
    fn random_plugin_json_decoding_never_panics_or_emits_invalid_coordinates() {
        cases(0x494e505554, 5_000, |rng| {
            // route passes input["event"] directly, even for malformed bodies.
            let body = rng.json(4);
            check_event(&body["event"]);
            check_event(&body);
            let event = json!({"kind": "pointer", "type": rng.json(2), "x": rng.json(2), "y": rng.json(2),
                "fine": {"x": rng.json(2), "y": rng.json(2)}, "button": rng.json(2),
                "key": rng.json(2), "ctrl": rng.json(2), "meta": rng.json(2), "shift": rng.json(2)});
            check_event(&event);
            let event = json!({"kind": "key", "key": rng.string(128), "ctrl": rng.below(2) == 0,
                "meta": rng.below(2) == 0, "shift": rng.below(2) == 0});
            check_event(&event);
        });
    }

    #[test]
    fn pointer_overflow_and_unrepresentable_coordinates_are_refused() {
        for event in [json!({"x": 1e308}), json!({"y": -1e308}), json!({"fine": {"x": 1e308}}),
            json!({"fine": {"y": 1e308}}), json!({"x": i64::MAX}), json!({"x": -1e100})] {
            assert!(pointer_coordinates(&event, 16.0, 0.0, 1.0, 0.0).is_err(), "{event}");
        }
        for (cell_h, top, scale, at) in [(f64::MAX, f64::MAX, 1.0, 0.0), (16.0, 0.0, 0.0, 0.0),
            (16.0, 0.0, f64::MIN_POSITIVE, 0.0), (16.0, 0.0, 1.0, f64::INFINITY)] {
            assert!(pointer_coordinates(&json!({"x": 1, "y": 1}), cell_h, top, scale, at).is_err());
        }
    }

    #[test]
    fn ordinary_pointer_coordinates_and_fine_positions_are_unchanged() {
        cases(0x504f494e544552, 5_000, |rng| {
            let x = rng.below(2000) as f64 - 1000.0;
            let y = rng.below(2000) as f64 - 1000.0;
            let top = rng.below(10000) as f64;
            let at = rng.below(10000) as f64;
            let cell_h = 8.0 + rng.below(32) as f64;
            let scale = [0.5, 1.0, 1.5, 2.0][rng.below(4)];
            for (event, px, py) in [(json!({"x": x, "y": y}), (x + 0.5) * 8.0, (y + 0.5) * cell_h),
                (json!({"x": 9999, "y": 9999, "fine": {"x": x, "y": y}}), x * 8.0, y * cell_h)] {
                let point = pointer_coordinates(&event, cell_h, top, scale, at).unwrap();
                assert_eq!([point.x, point.y, point.vy, point.fx, point.fy], [px, py, py + top - at, px / scale, (py + top) / scale]);
            }
        });
        let point = pointer_coordinates(&Value::Null, 16.0, 0.0, 1.0, 0.0).unwrap();
        assert_eq!((point.x, point.y), (4.0, 8.0));
    }

    #[test]
    fn key_modifiers_follow_plugin_boolean_and_unicode_rules() {
        for key in ["a", "A", "é", "😀", "👍🏽", "up", "f12", "\x1b[23~", "", "\0"] {
            for mask in 0..8 {
                let event = json!({"key": key, "ctrl": mask & 1 != 0, "meta": mask & 2 != 0, "shift": mask & 4 != 0});
                let (raw, name, mods) = key_input(&event);
                assert_eq!(raw, key);
                assert_eq!(name, key_name(key));
                assert_eq!(mods.contains(&"Control".into()), mask & 1 != 0);
                assert_eq!(mods.contains(&"Meta".into()), mask & 2 != 0);
                assert_eq!(mods.contains(&"Shift".into()), mask & 4 != 0 && name.encode_utf16().count() > 1);
            }
        }
        assert!(key_input(&json!({"key": "up", "ctrl": 1, "meta": "true", "shift": [true]})).2.is_empty());
    }
    #[test]
    fn names_and_raw_terminal_keys() {
        for (key,want) in [("up","ArrowUp"),("f12","F12"),("\x1bOQ","F2"),("\x1b[23~","F11"),("\x1b[2~","Insert"),("space"," "),("😀","😀"),("👍🏽","👍🏽")] {
            assert_eq!(key_name(key),want);
        }
        assert!(!is_key_name("\x1b[99~")); assert!(!is_key_name("F13")); assert!(!is_key_name("F01"));
        assert!(is_key_name("F12"));assert!(is_key_name("ArrowRight"));
        assert_eq!(definition("a"),("KeyA".into(),65)); assert_eq!(definition("F12"),("F12".into(),123));
    }
}
