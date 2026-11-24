# /deck — Lightweight Agent Multiplexer for Antigravity (`agy`)

Multiplexor visual ultraligero para Windows inspirado en **cmux** y **wmux**, diseñado para ejecutarse directamente desde cualquier sesión de **Google Antigravity CLI (`agy`)** escribiendo `/deck`.

## Características

- **Flujo nativo `agy` -> `/deck`**: Abre tu terminal de siempre, corre `agy` y escribe `/deck` para abrir el panel visual en `<0.5s`.
- **Layout estilo `cmux`**:
  - **Sidebar izquierdo**: Tarjetas con número de panel, rol/etiqueta libre (editable con doble clic), preview de la última línea en vivo, chips de subagentes reales detectados desde `~/.gemini/antigravity-cli/`, estado (`Running` / `Waiting`), rama Git y ruta.
  - **Cuadrícula Split-Pane automática**: Terminales reales en Windows (ConPTY / PowerShell) con **anillo azul brillante (`#3b82f6`)** cuando una terminal termina su turno o espera confirmación.
- **Aislamiento por defecto y Grupos por color (sin emojis)**:
  - `Aislado` (`#52525b` Gris neutro) — **Modo por defecto**: para tareas independientes (resetear una USB, investigar un tema, usar el browser) sin comunicación cruzada.
  - `Grupo A` (`#10b981` Esmeralda)
  - `Grupo B` (`#f59e0b` Ámbar)
  - `Grupo C` (`#a855f7` Violeta)
  - `Grupo D` (`#f43f5e` Rosa/Coral)
- **Comunicación entre agentes del mismo grupo**:
  - Solo los paneles vinculados en el mismo grupo (`A`, `B`, `C` o `D`) pueden verse con `deck peers` y enviarse prompts/mensajes con `deck send <rol> "mensaje"`.
- **Soporte `agy --remote-control`**: Botón y flag `--remote-control` integrados para lanzar instancias conectadas al daemon oficial de Remote Control de Antigravity.

## Uso rápido

```powershell
# Abrir la ventana visual de /deck
deck open

# Crear paneles aislados (por defecto)
deck spawn "Resetear USB"
deck spawn "Investigar Paper" --agy

# Crear o vincular paneles en un Grupo para que colaboren
deck spawn --role "api" --group A --remote-control
deck spawn --role "ui" --group A --remote-control
deck link "api" "ui" A

# Cambiar el rol de una terminal
deck role 1 "orquestador"

# Enviar mensaje entre compañeros del mismo grupo
deck send ui "Endpoint /users listo"
```
