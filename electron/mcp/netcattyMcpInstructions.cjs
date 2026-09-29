"use strict";

const NETCATTY_MCP_SERVER_INSTRUCTIONS =
  "Netcatty tools cover terminals, hosts, SFTP, vault, snippets/scripts, and port forwards; never use the local shell for Netcatty session commands. Call get_environment first, select by label or hostname, and pass sessionId to terminal_execute/terminal_start; if none matches, use vault_hosts_list and host_open. 16 core tools start loaded; load more categories with load_netcatty_tools (all for every tool). If a loaded tool cannot be called (unsupported call), use call_netcatty_tool.";

module.exports = { NETCATTY_MCP_SERVER_INSTRUCTIONS };
