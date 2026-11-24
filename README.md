# /deck — Multiplexor TUI Nativo para Antigravity (`agy`)

Multiplexor de terminales nativo en Windows Terminal inspirado en **cmux** y **wmux**, construido con `node-pty` y `@xterm/headless` (TrueColor, sin navegador) para orquestar múltiples sesiones de **Google Antigravity CLI (`agy`)** y terminales PowerShell.

## Características

- **TUI nativo en terminal**: Se abre directo en una pestaña de Windows Terminal (`wt.exe -w 0 new-tab`) al ejecutar `deck open` o `/deck` dentro de `agy`.
- **Sidebar + Split Grid (hasta 4 paneles visibles)**:
  - Tarjetas con número de panel, rol editable, grupo por color, estado (`Running` / `Waiting` / `Done`), última línea y rama Git.
  - **Indicadores visuales y de sonido**: borde **verde** al terminar turno (`Done`) con notificación toast de Windows y alerta sonora; borde **azul** cuando espera confirmación (`Waiting`).
  - **Scrollback por panel**: rueda del ratón para revisar historial (`[HISTORIAL]`); al escribir vuelve al final automáticamente.
- **Aislamiento por defecto y Grupos por color**:
  - `Aislado` (Gris) — **Modo por defecto**, sin comunicación cruzada.
  - `Grupo A` (Esmeralda), `Grupo B` (Ámbar), `Grupo C` (Violeta), `Grupo D` (Rosa).
- **Comunicación autónoma entre pares del mismo grupo**:
  - `deck send <rol> "<mensaje>"` inyecta el mensaje directo en el PTY destino (o lo encola si está `Running`) e instruye al panel destino a confirmar/responder al terminar con `--reply` (evitando bucles infinitos de respuesta).
- **Restauración de sesión**:
  - Guarda el estado en `.deck-state.json` (roles, grupos, rutas y `conversationId` de `agy`) y al reabrir pregunta `[S]` para restaurar (`agy --conversation <id>`) o `[N]` para iniciar desde cero.

## Requisitos e Instalación

- **Node.js** (v18+ recomendado)
- **Windows Terminal** (`wt.exe`) para abrir en pestaña nativa con `--tab` (o fallback automático a PowerShell)
- **Google Antigravity CLI (`agy`)** en el `PATH` si vas a lanzar sesiones de agente
- **Build tools de Windows** (solo si `node-pty` requiere compilar el módulo nativo)

```powershell
git clone <url-del-repo> C:\Users\Rogue\deck
cd C:\Users\Rogue\deck
npm install

# Opcional: exponer el comando `deck` globalmente
npm link
```

## Inicio Rápido

```powershell
# Abrir en la terminal actual
npm start
# o con el CLI global:
deck open

# Abrir en una pestaña nueva de Windows Terminal
node "C:\Users\Rogue\deck\bin\deck.js" open --tab
```

## Atajos y Ratón en el TUI

| Atajo / Acción | Función |
|---|---|
| `F1` | Nueva terminal PowerShell (Aislada) |
| `F3` | Nueva sesión `agy` (Aislada) |
| `F4` | Nueva sesión `agy --remote-control` (Aislada) |
| `F5` o clic en pill de grupo | Cambiar grupo (`Aislado` → `A` → `B` → `C` → `D`) |
| `F6` | Renombrar rol del panel enfocado |
| `F7` | Cerrar panel enfocado |
| `Tab` / `Alt+Tab` | Siguiente terminal |
| `Shift+Tab` | Terminal anterior |
| `Ctrl+Q` | Guardar sesión y salir |
| Clic en tarjeta o panel | Enfocar panel |
| Rueda del ratón | Scroll en el historial del panel |

## Referencia CLI

> Nota: Dentro de cada panel, `/deck` inyecta `DECK_PORT`, `DECK_PANE_ID`, `DECK_ROLE` y `DECK_GROUP` automáticamente para que `peers`, `role`, `group` y `send` identifiquen al remitente.

| Comando | Descripción |
|---|---|
| `deck open [--tab]` | Abre el TUI (alias: `tui`, `ui`). `--tab` fuerza nueva pestaña en Windows Terminal. |
| `deck list` | Lista todos los paneles activos, su grupo, estado y directorio. |
| `deck peers` | Lista únicamente los compañeros en el mismo grupo que el panel actual. |
| `deck spawn [rol] [opciones]` | Crea un nuevo panel (alias: `split`). Opciones: `--role <rol>`, `--group <A..D>`, `--cwd <ruta>`, `--agy`, `--remote-control`, `--prompt "<texto>"`. |
| `deck role [panel] <nuevo-rol>` | Cambia el rol/etiqueta de un panel (por defecto el panel actual). |
| `deck link <rol1> <rol2> [A\|B\|C\|D]` | Vincula dos paneles en el mismo grupo de color (por defecto `A`). |
| `deck group [panel] <A\|B\|C\|D\|isolated>` | Asigna un panel a un grupo o lo devuelve a `isolated`. |
| `deck isolate [panel]` | Pone un panel en modo `Aislado`. |
| `deck send <rol> "<mensaje>" [--reply] [--force]` | Envía un mensaje a un compañero del mismo grupo (`--reply` marca que es respuesta y omite pedir confirmación; `--force` fuerza envío fuera de contexto PTY). |

### Ejemplos

```powershell
# Crear paneles en Grupo A
node "C:\Users\Rogue\deck\bin\deck.js" spawn --role "api" --group A --agy
node "C:\Users\Rogue\deck\bin\deck.js" spawn --role "ui" --group A --remote-control

# Renombrar y vincular paneles existentes
node "C:\Users\Rogue\deck\bin\deck.js" role "api" "backend"
node "C:\Users\Rogue\deck\bin\deck.js" link "backend" "ui" A

# Enviar mensaje al compañero del mismo grupo
node "C:\Users\Rogue\deck\bin\deck.js" send "ui" "Endpoint /users listo"

# Volver a aislar un panel
node "C:\Users\Rogue\deck\bin\deck.js" isolate "backend"
```

## Variables de Entorno

| Variable | Por defecto | Uso |
|---|---|---|
| `DECK_PORT` | `4777` | Puerto HTTP/WebSocket del servidor local de `/deck`. |
| `DECK_NO_NOTIFY` | `0` | Pon `1` para desactivar notificaciones toast y alertas sonoras en Windows. |
| `DECK_NO_STATE` | `0` | Pon `1` para no leer ni escribir `.deck-state.json`. |
| `DECK_NO_DEFAULT_PANE` | `0` | Pon `1` para iniciar el servidor sin crear un panel PowerShell inicial. |

## Estructura del Proyecto

- `bin/deck.js` — CLI (`open`, `list`, `peers`, `spawn`, `role`, `link`, `group`, `isolate`, `send`).
- `tui.js` — Interfaz TUI nativa (renderizado ANSI TrueColor, ratón SGR, `@xterm/headless`, atajos).
- `server.js` — Daemon HTTP/WebSocket, gestión de PTYs (`node-pty`), grupos, cola de mensajes, notificaciones y `.deck-state.json`.
- `public/index.html` — Vista web auxiliar servida en `http://127.0.0.1:4777`.
- `test.js` — Pruebas unitarias de aislamiento, grupos, mensajería y restauración de sesión.

## Pruebas

```powershell
npm test
# o directamente:
node test.js
```
