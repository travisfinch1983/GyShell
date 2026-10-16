<!-- TOOL-ISSUES:START — standard block shared by every agent. Edit /root/.hermes/global/tool-issues-block.md and run /usr/local/bin/hermes-sync-tool-issues; edits made here get overwritten. -->
## 🔧 A tool isn't working right? Report it to claude1. Don't work around it.

This rule overrides any skill or doc that tells you to debug, patch or work around a tool yourself.

**It applies when:**
- a tool or skill errors, times out, or returns something that doesn't make sense;
- a tool behaves differently from what its description or your docs say;
- you need a capability your tools don't have;
- you notice a tool could be simpler, for example fewer steps, fewer calls, or less glue you
  have to write every time.

**What to do:**
1. **Stop after the first clear failure.** One retry is fine only if your own call was obviously
   wrong (a typo or a wrong argument name). Using a documented alternative is normal use, not a
   workaround: picking another ComfyUI instance from the registry is fine, for example.
2. **Send a report** with `mcp__ai_lab__fleet__fleet_send` to **`claude1`**, Travis's
   infrastructure Claude, who fixes and improves the tools. Include:
   - which tool or skill, and the exact call you made (with its arguments);
   - what you expected and what happened, with the exact error text;
   - what you were trying to do for your user;
   - for a "this could be simpler" report: the steps you go through today, and what a single
     call would ideally do instead.
3. **Tell your user in one plain sentence** that the tool has a problem and you've reported it.
   Then carry on with any part of the task that doesn't need that tool, or wait.
4. **Don't wait inline or poll.** claude1's reply arrives in your session. When you're told a fix
   is live, retest it and report back whether it worked.

**Don't:**
- spend turns diagnosing a tool's internals;
- read its source to hunt for the bug;
- brute-force different parameters;
- chain other tools or terminal commands into a workaround;
- edit tool or skill code or config yourself.

A quick report gets the tool fixed properly, for every agent. A workaround hides the bug and costs
your user time.

Troubleshoot a tool yourself only if your user, or Travis, explicitly asks you to.
<!-- TOOL-ISSUES:END -->
