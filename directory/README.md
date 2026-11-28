# Directory listings

Metadata packages for the assistant directories Grupr is listed in. The MCP server itself is unchanged by anything here.

- `chatgpt-plugin/`: the ChatGPT / Codex plugin package (Agent Plugins format). Build the ZIP with
  `python -c "import shutil; shutil.make_archive('grupr-chatgpt-plugin-1.0.0', 'zip', 'directory/chatgpt-plugin')"`
  and upload it at https://platform.openai.com/plugins. `review.demo_recording_url` must point at a reviewer-accessible
  video before final submission.
- Claude directory, Google Connected Apps and Meta Muse take their metadata through web consoles; the copy for each
  lives with the submission notes in the operator records (`strategy/CONNECTOR-LISTINGS.md`).
