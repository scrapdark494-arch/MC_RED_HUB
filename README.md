# MC RED HUB API 4.0

Backend compartido para la app Android y el panel web MC RED HUB. La raíz del servicio no tiene login de usuarios.

## Stack
- Node.js + Express
- Supabase Postgres para perfiles, catálogo, servidores, reseñas, actividad y mensajes
- Supabase Storage privado para mods, mundos, skins e imágenes
- Socket.IO en Render para chat en tiempo real

## Despliegue en Render
Build command: `npm install`
Start command: `npm start`

Variables privadas obligatorias:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Opcionales:
- `SUPABASE_BUCKET=mcrh-files`
- `MAX_FILE_MB=50`
- `PORT` (Render lo proporciona)

Nunca pongas `SUPABASE_SERVICE_ROLE_KEY` en el APK ni en Netlify.

## Autenticación de perfiles
MC RED HUB 4.0 no usa Google ni contraseña. Al crear el perfil se envían un Nick y una foto. El servidor asigna una clave aleatoria y guarda solamente su hash en `api_tokens`. En Android la clave se guarda en SharedPreferences privadas y se manda como Bearer token.

La identidad es por instalación. Si se borran los datos de la app o se cambia de teléfono no se puede recuperar el perfil solo con Nick y foto. El contenido comunitario sigue en la base central.

## Endpoints principales
- `GET /api/health` — conexión de base de datos y Storage
- `GET /api/config` — parámetros públicos
- `POST /api/auth/register` — Nick + foto; devuelve token de dispositivo
- `GET /api/me` — perfil asociado al token
- `GET/POST /api/mods`, `/api/skins`, `/api/worlds`, `/api/servers`
- `GET/POST /api/reviews` — reseñas con puntuación 1–5 para mod, skin, mundo o servidor
- `POST /api/track-download` — registrar descargas
- Socket.IO `chat:join`, `chat:history`, `chat:message` — mensajes guardados en Postgres
- `GET /api/public/dashboard` — vista pública de lectura del panel Netlify

## Netlify
`netlify-site` sirve el panel de consulta sin inicio de sesión. Las reglas `netlify.toml` y `_redirects` reenvían `/api/*` a Render. Socket.IO usa el host Render directamente.
