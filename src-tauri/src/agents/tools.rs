//! The MCP tools each agent gets (server "shellmosaic"): the lead directs the team,
//! workers report back.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::core::{Answer, Core};
use super::mcp::{BoxFut, CallCtx, Tool, ToolHost, ToolOutput};
use super::proto::Role;

pub struct AgentTools {
    core: Arc<Core>,
    agent: String,
    role: Role,
}

impl AgentTools {
    pub fn new(core: Arc<Core>, agent: String, role: Role) -> Self {
        Self { core, agent, role }
    }
}

fn schema(props: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": props, "required": required, "additionalProperties": false })
}

fn tool(name: &'static str, description: &str, input_schema: Value) -> Tool {
    Tool { name, description: description.into(), input_schema }
}

fn lead_tools() -> Vec<Tool> {
    let worker = json!({ "type": "string", "description": "Worker slot (w1, w2, w3) or name" });
    vec![
        tool("status", "Your team right now: workers and what they do, tasks and their status, requests waiting.", schema(json!({}), &[])),
        tool(
            "create_task",
            "Create a task for a worker. Write the description so a fresh session can do it alone: goal, where in the code, constraints, how to verify. Difficulty 1-5 picks the model (1 Haiku, 2-3 Sonnet, 4-5 Opus).",
            schema(
                json!({
                    "title": { "type": "string", "description": "Short title" },
                    "description": { "type": "string", "description": "Everything the worker needs to know" },
                    "difficulty": { "type": "integer", "minimum": 1, "maximum": 5 },
                    "follow_up_of": { "type": "string", "description": "A finished task this continues (same worker, same conversation)" }
                }),
                &["title", "description", "difficulty"],
            ),
        ),
        tool(
            "assign_task",
            "Start a queued task on a worker, or retry a failed one (after two failures it runs one model level up). Leave out `worker` to let Shellmosaic pick an idle worker or start a new one (the usual way); name a slot (w1-w3) only to choose. Returns right away; use wait for the result.",
            schema(
                json!({ "task_id": { "type": "string" }, "worker": { "type": "string", "description": "Optional: worker slot (w1, w2, w3); a free slot starts a new worker" } }),
                &["task_id"],
            ),
        ),
        tool(
            "wait",
            "Wait until something happens in your team (a task finished, failed or is blocked, a worker asks you something, a worker stopped or exited) and return those events.",
            schema(json!({ "timeout_s": { "type": "integer", "minimum": 5, "maximum": 1500, "description": "Default 300" } }), &[]),
        ),
        tool(
            "read_output",
            "A worker's recent conversation (its messages and tool calls).",
            schema(json!({ "worker": worker, "max_entries": { "type": "integer", "minimum": 5, "maximum": 200 } }), &["worker"]),
        ),
        tool(
            "message_worker",
            "Type a message to a worker (an idle one answers it; a busy one gets it after its current step).",
            schema(json!({ "worker": worker, "text": { "type": "string" } }), &["worker", "text"]),
        ),
        tool(
            "answer_question",
            "Answer a worker's question (the request id from wait or status, e.g. r4).",
            schema(json!({ "request_id": { "type": "string" }, "answer": { "type": "string" } }), &["request_id", "answer"]),
        ),
        tool(
            "review_task",
            "Accept a finished task (its branch is merged into orch/integration) or send it back with a note saying what to change.",
            schema(
                json!({ "task_id": { "type": "string" }, "accept": { "type": "boolean" }, "note": { "type": "string", "description": "Required when sending it back" } }),
                &["task_id", "accept"],
            ),
        ),
        tool("interrupt_worker", "Stop a worker's current turn (like pressing Esc in its pane).", schema(json!({ "worker": worker }), &["worker"])),
        tool(
            "dismiss_worker",
            "Remove a worker that has nothing left to do (its open task goes back to the queue).",
            schema(json!({ "worker": worker }), &["worker"]),
        ),
        tool("cancel_task", "Cancel a task (a worker on it is interrupted).", schema(json!({ "task_id": { "type": "string" } }), &["task_id"])),
        tool("notify_user", "Show the user a short notice in Shellmosaic.", schema(json!({ "text": { "type": "string" } }), &["text"])),
    ]
}

fn worker_tools() -> Vec<Tool> {
    vec![
        tool("get_task", "Your current task.", schema(json!({}), &[])),
        tool(
            "complete_task",
            "Report your task: done (finished and verified), failed (can't be done), or blocked (needs something only the lead can give). Commit your work first. Then stop.",
            schema(
                json!({
                    "summary": { "type": "string", "description": "What you changed, how you verified it, anything left open" },
                    "status": { "type": "string", "enum": ["done", "failed", "blocked"] }
                }),
                &["summary", "status"],
            ),
        ),
        tool(
            "ask_lead",
            "Ask the lead a question and wait for the answer (use instead of guessing on decisions that matter).",
            schema(json!({ "question": { "type": "string" } }), &["question"]),
        ),
        tool("report_progress", "A one-line progress note for the lead and the user.", schema(json!({ "text": { "type": "string" } }), &["text"])),
    ]
}

fn s<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key).and_then(Value::as_str).filter(|v| !v.trim().is_empty()).ok_or_else(|| format!("\"{key}\" is required"))
}

fn opt<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).filter(|v| !v.trim().is_empty())
}

/// Git and process work runs off the async workers.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

impl AgentTools {
    async fn lead(&self, name: &str, args: Value, ctx: CallCtx) -> Result<String, String> {
        let core = self.core.clone();
        let run = core.run_of(&self.agent).ok_or("You're no longer part of a team.")?;
        match name {
            "status" => Ok(core.status_text(&run)),
            "create_task" => {
                let difficulty = args.get("difficulty").and_then(Value::as_u64).unwrap_or(2).clamp(1, 5) as u8;
                let t = core.create_task(&run, s(&args, "title")?, s(&args, "description")?, difficulty, opt(&args, "follow_up_of"))?;
                Ok(format!("Created {} (difficulty {}). Assign it with assign_task.", t.id, t.difficulty))
            }
            "assign_task" => {
                let task = s(&args, "task_id")?.to_string();
                let worker = opt(&args, "worker").map(str::to_string);
                let c = core.clone();
                let id = blocking(move || c.assign(&task, worker.as_deref())).await?;
                let a = core.find_agent(&run, &id)?;
                Ok(format!("{} goes to {} ({}, {}). It starts in the background; call wait for the result.", s(&args, "task_id")?, a.name, a.slot, a.model))
            }
            "wait" => {
                let secs = args.get("timeout_s").and_then(Value::as_u64).unwrap_or(300).clamp(5, 1500);
                let news = core.take_lead_events(&run);
                if !news.is_empty() {
                    let mut out: Vec<String> = news.iter().map(|e| format!("- {}", e.text)).collect();
                    out.push(String::new());
                    out.push(core.status_text(&run));
                    return Ok(out.join("\n"));
                }
                if !core.in_progress(&run) {
                    return Ok(format!("Nothing is in progress, so there's nothing to wait for. Assign a task first (assign_task).\n\n{}", core.status_text(&run)));
                }
                match core.wait_events(&run, Duration::from_secs(secs), &ctx).await {
                    None => Err("cancelled".into()),
                    Some(events) if events.is_empty() => Ok(format!("Nothing new in {secs} s. {}", core.status_text(&run))),
                    Some(events) => {
                        let mut out: Vec<String> = events.iter().map(|e| format!("- {}", e.text)).collect();
                        out.push(String::new());
                        out.push(core.status_text(&run));
                        Ok(out.join("\n"))
                    }
                }
            }
            "read_output" => {
                let a = core.find_agent(&run, s(&args, "worker")?)?;
                let n = args.get("max_entries").and_then(Value::as_u64).unwrap_or(40).clamp(5, 200) as usize;
                core.read_output(&a.id, n)
            }
            "message_worker" => {
                let a = core.find_agent(&run, s(&args, "worker")?)?;
                core.send(&a.id, s(&args, "text")?).await?;
                Ok(format!("Sent to {}.", a.name))
            }
            "answer_question" => {
                let id = s(&args, "request_id")?.trim().to_string();
                if !core.questions_of_run(&run, &id) {
                    return Err(format!("{id} isn't a question from your team (permission requests are the user's to answer)."));
                }
                core.answer(&id, Answer::Text(s(&args, "answer")?.to_string()), "lead")?;
                Ok(format!("Answered {id}."))
            }
            "review_task" => {
                let task = s(&args, "task_id")?.to_string();
                let accept = args.get("accept").and_then(Value::as_bool).ok_or("\"accept\" is required")?;
                let note = opt(&args, "note").unwrap_or("").to_string();
                if !accept && note.trim().is_empty() {
                    return Err("Say what to change in \"note\".".into());
                }
                let c = core.clone();
                blocking(move || c.review(&task, accept, &note)).await
            }
            "interrupt_worker" => {
                let a = core.find_agent(&run, s(&args, "worker")?)?;
                core.interrupt(&a.id, false)?;
                Ok(format!("Interrupted {}.", a.name))
            }
            "dismiss_worker" => {
                let a = core.find_agent(&run, s(&args, "worker")?)?;
                let c = core.clone();
                let id = a.id.clone();
                blocking(move || c.remove_agent(&id)).await?;
                Ok(format!("Removed {}.", a.name))
            }
            "cancel_task" => {
                let task = s(&args, "task_id")?.to_string();
                core.cancel_task(&task)?;
                Ok(format!("Cancelled {task}."))
            }
            "notify_user" => {
                core.notice(&self.agent, s(&args, "text")?);
                Ok("Shown.".into())
            }
            _ => Err(format!("unknown tool {name}")),
        }
    }

    async fn worker(&self, name: &str, args: Value, ctx: CallCtx) -> Result<String, String> {
        let core = self.core.clone();
        match name {
            "get_task" => {
                let snap = core.snapshot();
                let me = snap.agents.iter().find(|a| a.id == self.agent).ok_or("You're no longer part of a team.")?;
                match me.task_id.as_deref().and_then(|t| snap.tasks.iter().find(|x| x.id == t)) {
                    Some(t) => Ok(super::roles::task_message(t, false)),
                    None => Ok("You have no task right now. Stop and wait for the next one.".into()),
                }
            }
            "complete_task" => {
                let summary = s(&args, "summary")?.to_string();
                let status = opt(&args, "status").unwrap_or("done").to_string();
                let (c, id) = (core.clone(), self.agent.clone());
                blocking(move || c.complete_task(&id, &summary, &status)).await
            }
            "ask_lead" => {
                let out = core.ask_lead(&self.agent, s(&args, "question")?, ctx).await;
                if out.is_error {
                    Err(out.text)
                } else {
                    Ok(out.text)
                }
            }
            "report_progress" => {
                core.progress(&self.agent, s(&args, "text")?);
                Ok("Noted.".into())
            }
            _ => Err(format!("unknown tool {name}")),
        }
    }
}

impl ToolHost for AgentTools {
    fn server_name(&self) -> &'static str {
        "shellmosaic"
    }

    fn instructions(&self) -> Option<String> {
        Some(match self.role {
            Role::Lead => "Shellmosaic Orchestrator: create tasks, assign them to worker agents, wait for results and review them.".into(),
            Role::Worker => "Shellmosaic Orchestrator: when your task is finished call complete_task; ask the lead with ask_lead.".into(),
        })
    }

    fn tools(&self) -> Vec<Tool> {
        match self.role {
            Role::Lead => lead_tools(),
            Role::Worker => worker_tools(),
        }
    }

    fn call(self: Arc<Self>, name: String, args: Value, ctx: CallCtx) -> BoxFut<ToolOutput> {
        Box::pin(async move {
            let res = match self.role {
                Role::Lead => self.lead(&name, args, ctx).await,
                Role::Worker => self.worker(&name, args, ctx).await,
            };
            match res {
                Ok(text) => ToolOutput::ok(text),
                Err(e) => ToolOutput::err(e),
            }
        })
    }
}
