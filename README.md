# Shadowbridge MCP

Personal Foundry VTT bridge for Codex/Claude maintenance work.

This is original, narrow-scope code. It is not a fork or repackaging of another Foundry MCP bridge.

## Pieces

- `foundry-module/` - Foundry module installed into your world.
- `server/` - local MCP server launched by Codex/Claude.
- `release/` - packaged Foundry module zips.

## How It Works

The MCP server runs locally on your machine and listens on `127.0.0.1:31777`.

The Foundry module runs in your GM browser tab and long-polls that local server. Commands only execute from a GM client, and the token in Foundry settings must match the MCP server token.

This avoids needing filesystem access to the remote Foundry server after the module is installed.

## First Tools

- `list_connected_worlds`
- `get_world_info`
- `get_actor`
- `search_actor_items`
- `manage_actor_items`
- `manage_actor_effects`
- `manage_item_effects`
- `manage_actor_flags`
- `update_token_image`
- `get_current_scene`
- `manage_encounter_director`
- `manage_exalted_scenes`
- `find_foundry_assets`
- `setup_koczech_phase1`

## Foundry Setup

1. Install the module with this manifest URL:

   `https://raw.githubusercontent.com/imabeast5212011-sketch/shadowbridge-mcp/main/foundry-module/module.json`

2. Enable `Shadowbridge MCP` in your world.
3. In module settings:
   - server URL: `http://127.0.0.1:31777`
   - token: contents of `shadowbridge-token.txt`
4. Keep the world open in a GM Chrome tab.

The release zip is also checked into `release/shadowbridge-mcp-module-0.1.14.zip` for manual installs.

## MCP Server

Run:

```powershell
node K:\FoundryMigration\CurseShadowfiend\shadowbridge-mcp\server\shadowbridge-mcp.js
```

The first run creates `shadowbridge-token.txt` if it does not already exist.

## MCP Config Example

```json
{
  "mcpServers": {
    "shadowbridge": {
      "command": "node",
      "args": [
        "K:\\FoundryMigration\\CurseShadowfiend\\shadowbridge-mcp\\server\\shadowbridge-mcp.js"
      ]
    }
  }
}
```

If you prefer environment variables, set:

- `SHADOWBRIDGE_PORT`
- `SHADOWBRIDGE_HOST`
- `SHADOWBRIDGE_TOKEN`
