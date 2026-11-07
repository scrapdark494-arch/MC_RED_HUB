# MC RED HUB — plataforma web para Minecraft Bedrock

Proyecto web responsive / PWA en español para comunidad Bedrock. Incluye catálogo comunitario de complementos, gestión local de copias de mundos, editor de skins PNG 64×64, galería de skins, publicaciones de servidores y chat en tiempo real por servidor.

## Funciones incluidas

- **Inicio:** portada, accesos rápidos y publicaciones recientes.
- **Mods:** búsqueda por nombre/creador/descripción, filtros por versión y categoría, orden por fecha o descargas, portada opcional, archivo `.mcpack` / `.mcaddon` o enlace externo HTTPS.
- **Mis mundos:** importa `.mcworld` y `.zip`, conserva las copias en IndexedDB en el navegador/dispositivo actual, permite descargarlas o eliminarlas.
- **Skin Lab:** editor de textura 64×64 con pincel, borrador, relleno, simetría, paleta, deshacer, importación PNG y exportación PNG.
- **Galería de skins:** usuarios con Google pueden publicar sus PNG y otros usuarios pueden verlos, abrirlos en el editor o descargarlos.
- **Servidores:** publicación de servidores Bedrock con nombre, dirección, puerto, versión, requisitos y descripción; los usuarios pueden copiar la dirección y abrir el canal de chat.
- **Chat:** chat en tiempo real por servidor con historial persistente y distintivo automático del creador. Se requiere inicio de sesión Google.
- **PWA:** manifest y service worker para poder instalar la página como aplicación web desde un navegador compatible.

No se agregan servidores o mods ficticios: el catálogo empieza vacío hasta que los creadores publiquen sus entradas. La página no verifica automáticamente que una IP esté en línea ni que un mod sea seguro o compatible; esa información la declara quien publica.

## Requisitos

- Node.js 20 o superior.
- npm.
- Una URL HTTPS pública para producción.
- Un proyecto OAuth de Google para habilitar el inicio de sesión real.
- Almacenamiento persistente para las carpetas `data/` y `uploads/` en el servidor de producción.

## Ejecutar en local

1. Descomprime el proyecto.
2. Abre una terminal dentro de la carpeta `mc-red-hub`.
3. Instala dependencias:

   ```bash
   npm install
   ```

4. Copia `.env.example` a `.env`.
5. Para habilitar Google, configura `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` y `BASE_URL` como se explica más abajo.
6. Inicia la aplicación:

   ```bash
   npm start
   ```

7. Abre `http://localhost:3000`.

La aplicación web sirve tanto la interfaz como su API, base de datos SQLite, sesiones persistentes en SQLite y servicio Socket.IO del chat.

## Configurar inicio de sesión Google

Sin estas credenciales, la página y el editor local funcionan; la publicación de mods y las descargas públicas no requieren Google. Para subir skins, publicar servidores y entrar al chat sí se necesita configurar el inicio de sesión Google.

1. Entra a Google Cloud Console y crea o selecciona un proyecto.
2. Configura la pantalla de consentimiento OAuth.
3. Crea un ID de cliente OAuth de tipo **Aplicación web**.
4. En **Orígenes autorizados de JavaScript**, agrega el origen exacto, por ejemplo `https://tudominio.com`.
5. En **URI de redireccionamiento autorizados**, agrega exactamente `https://tudominio.com/auth/google/callback` y `https://tudominio.com/auth/google/android/callback`.
6. Copia el ID y el secreto de cliente a `.env`:

   ```env
   BASE_URL=https://tudominio.com
   GOOGLE_CLIENT_ID=tu-client-id
   GOOGLE_CLIENT_SECRET=tu-client-secret
   SESSION_SECRET=una-clave-aleatoria-larga-y-privada
   COOKIE_SECURE=true
   ```

7. Reinicia el servidor.

Para pruebas locales, registra también `http://localhost:3000` y `http://localhost:3000/auth/google/callback` en Google Cloud y usa `BASE_URL=http://localhost:3000` con `COOKIE_SECURE=false`.

**No publiques el archivo `.env` ni compartas el secreto de Google.**

## Despliegue

Despliega como servicio Node.js, no como hosting estático puro, porque el proyecto necesita Express, SQLite y Socket.IO. Configura las variables del archivo `.env` como variables secretas del proveedor. Asigna un disco/volumen persistente y configura:

- `data/` para `mc-red-hub.sqlite` (incluye la tabla de sesiones).
- `uploads/` para archivos de mods y skins.

Si el proveedor elimina archivos al reiniciar o redeplegar, se perderán las publicaciones y los archivos. Haz copias de seguridad del volumen. En producción utiliza HTTPS, `COOKIE_SECURE=true`, secretos aleatorios y límites/monitorización de almacenamiento.

## Notas importantes de funcionamiento

- **Copias de mundos:** se guardan en IndexedDB del navegador del jugador, no en el servidor ni sincronizadas con Google. Borrar los datos del navegador puede borrar esas copias. Cuando el usuario descarga un `.mcworld`, debe abrirlo desde Android con Minecraft Bedrock para importarlo. Una página web no puede escribir directamente dentro de las carpetas privadas de Minecraft.
- **Skins:** Skin 3D Lab muestra un personaje Minecraft en 3D que gira y se actualiza al editar su atlas UV PNG 64×64. Exporta el PNG para importarlo manualmente en Minecraft; no aplica la skin directamente a una cuenta Microsoft.
- **Mods:** el botón descarga el archivo que el creador subió o redirige al enlace HTTPS registrado. El usuario debe abrir el `.mcpack` o `.mcaddon` con Minecraft para importarlo.
- **Servidores:** la ficha muestra versión/requisitos declarados por el creador. El botón Copiar IP copia dirección y puerto; no conecta automáticamente al servidor desde el navegador.
- **Chat:** es un canal público asociado a cada ficha de servidor, no un mensaje privado individual. Requiere Google y una sesión activa.
- **Moderación:** es una base funcional inicial. Antes de abrirla al público, añade moderación, reportes, reglas comunitarias, límites de frecuencia más robustos, protección CSRF y políticas de privacidad/retención. ClamAV analiza los archivos subidos si sus firmas están disponibles; los enlaces externos no se pueden analizar desde este servidor.
- **Minecraft:** MC RED HUB es un proyecto independiente, no afiliado, aprobado ni respaldado por Mojang o Microsoft.


## Actualización MC RED HUB (editor 3D, publicación abierta y seguridad)

- El editor Skin 3D Lab incorpora un modelo de personaje giratorio, capas exteriores, vistas frontal/lateral/trasera, zoom, paleta, pincel, borrador, relleno, simetría, deshacer, limpiar, importación PNG y exportación PNG. La textura UV Bedrock 64×64 es editable y actualiza la vista 3D.
- La publicación de mods es pública y no exige Google. El autor puede escribir un alias opcional (no verificado). Se aplica un límite básico por IP y las descargas siguen siendo públicas; conviene añadir CAPTCHA y moderación antes de abrirlo a gran escala. La publicación de skins, servidores y el chat siguen requiriendo Google.
- El servidor integra análisis de archivos con ClamAV. Por seguridad `AV_SCAN_REQUIRED=true` es el valor predeterminado: si ClamAV no está instalado y operativo, las subidas se rechazan. No se debe desactivar en una instalación pública. Los enlaces HTTPS externos no pueden analizarse desde el servidor.
- `STORAGE_ROOT` permite montar `data/` y `uploads/` en un volumen persistente. En producción el proveedor debe mantener ese volumen entre reinicios y redepliegues. Sin volumen persistente, los archivos y la base SQLite pueden perderse.
- En Android, el inicio de Google abre el navegador externo y vuelve a MC RED HUB mediante el enlace `mcredhub://auth`; así se evita ejecutar OAuth dentro del WebView. El dominio HTTPS y el callback OAuth deben configurarse antes de usarlo.

### Requisitos para publicar archivos con protección antivirus

Instala ClamAV en el mismo servidor (comando `clamscan`) o configura la variable `CLAMSCAN_BIN` con la ruta del ejecutable. Actualiza regularmente la base de firmas de ClamAV. El proceso de Node debe tener permiso para ejecutar el escáner y leer los archivos subidos. En plataformas con límites bajos de memoria puede ser necesario usar un servicio ClamAV remoto administrado por el operador; el código no finge que un antivirus está activo cuando no está disponible.

### Persistencia

Configura `STORAGE_ROOT` en la ruta donde el proveedor haya montado el disco persistente. Esa ubicación debe contener las carpetas `data/` y `uploads/`. Haz copias de seguridad periódicas de ambas. Un hosting gratuito que use disco efímero no puede garantizar que las publicaciones sobrevivan a reinicios.

### OAuth Google y Android

En Google Cloud Console crea un ID de cliente OAuth de tipo **Aplicación web**. Añade el origen `https://TU-DOMINIO` y el URI exacto `https://TU-DOMINIO/auth/google/callback` y `https://TU-DOMINIO/auth/google/android/callback`. Configura pantalla de consentimiento, audiencia y usuarios de prueba; para acceso público puede ser necesario verificar el dominio y completar la verificación de la aplicación según los ámbitos y políticas de Google. Guarda el ID y el secreto únicamente como variables secretas del servidor. No pegues el secreto dentro del APK.

La aplicación Android abre `/auth/google?client=android` en el navegador del sistema y vuelve mediante el esquema `mcredhub://auth` con un código de un solo uso, que el WebView canjea por su propia sesión segura. No se debe cambiar el enlace profundo ni el endpoint `/auth/native/exchange` sin actualizar ambos lados.


El inicio de sesión solicita únicamente los ámbitos básicos `openid`, `profile` y `email`; no solicita acceso a Gmail, Drive ni a otros servicios de Google. La disponibilidad de cuentas externas y cualquier revisión de marca/consentimiento dependen del estado de publicación configurado en Google Auth Platform.
