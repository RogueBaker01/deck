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
  - `deck send <rol> "<mensaje>"` inyecta el mensaje directo en el PTY destino (o lo encola si está `Running`) e instruye al panel destino a confirmar/responder al terminar con `--reply`.
- **Restauración de sesión**:
  - Guarda el estado en `.deck-state.json` (roles, grupos, rutas y `conversationId` de `agy`) y al reabrir pregunta `[S]` para restaurar (`agy --conversation <id>`) o `[N]` para iniciar desde cero.

## Atajos en el TUI

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
| Rueda del ratón | Scroll en el historial del panel |

## Uso por CLI

```powershell
# Abrir el multiplexor TUI
node "C:\Users\Rogue\deck\bin\deck.js" open --tab

# Listar paneles o solo compañeros del mismo grupo
node "C:\Users\Rogue\deck\bin\deck.js" list
node "C:\Users\Rogue\deck\bin\deck.js" peers

# Crear paneles
node "C:\Users\Rogue\deck\bin\deck.js" spawn --role "api" --group A --agy
node "C:\Users\Rogue\deck\bin\deck.js" spawn --role "ui" --group A --remote-control

# Gestionar roles y grupos
node "C:\Users\Rogue\deck\bin\deck.js" role "api" "backend"
node "C:\Users\Rogue\deck\bin\deck.js" link "backend" "ui" A
node "C:\Users\Rogue\deck\bin\deck.js" isolate "backend"

# Enviar mensaje entre compañeros del mismo grupo
node "C:\Users\Rogue\deck\bin\deck.js" send "ui" "Endpoint /users listo"
```

## Pruebas

```powershell
node test.js
```
