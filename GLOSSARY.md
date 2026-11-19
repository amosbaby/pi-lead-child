# pi-lead-child

A personal assistant (Lead) that takes the user's requests and the events of their work, and hands longer work to child agents.

## Lead and its sessions

**Lead**:
The user's assistant: one persistent conversation with the user, plus everything that acts in its name.
_Avoid_: bot, agent (without a qualifier)

**Main session**:
Lead's one long-lived conversation with the user, which keeps the whole history.
_Avoid_: Lead session (when the shadow is meant too), main thread

**Shadow** (中文也写 shadow，「Lead 的分身」):
Lead handling background events in a small session without the conversation history: the same identity, rules, tools and permissions, one new session for each batch of events. What it cannot or should not handle, it hands back to the main session.
_Avoid_: desk, background desk, 后台值班, sub-agent, triage shadow

**Hand back**:
The shadow giving an event to the main session, with why, what it found and what it suggests.
_Avoid_: escalate (in text for the user), forward

**Trial** (试运行):
A shadow mode in which the shadow handles the same batch as the main session but none of its actions take effect; only what it would have done is recorded, to compare.
_Avoid_: shadow mode, dry run (in text for the user)

**Share** (比例):
For one source of background events, the percent of its conversations or tickets that go to the shadow; one conversation or ticket always goes to the same side.
_Avoid_: ratio, sampling rate

**Triage shadow** (影子分诊):
A different, older thing: the cheap model's triage of events recorded next to the rules' triage, to compare. It has nothing to do with the shadow.
_Avoid_: shadow (alone)
