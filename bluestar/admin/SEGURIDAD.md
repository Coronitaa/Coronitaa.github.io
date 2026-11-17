# Panel de BlueStar: modelo de amenazas

## Qué se protege

`bluestar/catalog.json`, que BlueStar descarga de `https://coronitaa.github.io/bluestar/catalog.json` y usa para:
añadir y ocultar juegos en Explorar, y ofrecer en el instalador versiones recomendadas (build fijado, emulador, mods y nota).
Quien pueda escribir ese archivo decide qué descarga BlueStar en el PC de los usuarios, así que es el activo a proteger.

## Quién decide quién puede escribir: GitHub, no el panel

GitHub Pages es estático: no hay servidor propio que pueda comprobar una contraseña. Por eso el panel **no tiene login propio**
ni guarda ningún secreto en el JavaScript (cualquier comprobación en el navegador se puede saltar editando la página).

- El panel solo lee y escribe a través de la API de GitHub, con el token de quien lo usa.
- Un commit a `Coronitaa/Coronitaa.github.io` solo lo acepta GitHub si la cuenta tiene permiso de escritura en el repo.
  Saltarse la pantalla de login del panel no sirve de nada: sin ese permiso, GitHub rechaza el `PUT`.
- Suplantar al dueño exige robar su sesión de GitHub o un token suyo. Recomendado: 2FA en la cuenta, tokens
  fine-grained limitados a este repo con solo `Contents: Read and write` y caducidad corta.
- Cada cambio queda como commit firmado por la cuenta que lo hizo; se puede revisar y revertir con git.
- Escrituras concurrentes: el commit lleva el `sha` de la versión editada; si alguien publicó entretanto, GitHub lo rechaza (409)
  en vez de pisarlo.

## El token

- Se pide un token fine-grained; nunca la contraseña.
- Se guarda solo en `sessionStorage` (esta pestaña) y se borra con "Salir" o al cerrar la pestaña. No va en la URL ni a otro sitio
  que no sea `api.github.com`.
- La CSP solo permite conexiones a `api.github.com` (y al propio sitio), así que un script inyectado no podría mandarlo a otro dominio.

## La página

- CSP estricta en `<meta>`: `script-src 'self'` (sin scripts inline ni de terceros, sin `eval`), `connect-src` limitado a
  `api.github.com`, imágenes solo de los CDN de Steam y de Coronitaa, `base-uri 'none'`, `form-action 'none'`.
- Todo dato del catálogo se pinta con `textContent`/`value`, nunca con `innerHTML`, así que un nombre o nota con HTML se muestra como texto.
- La página se niega a ejecutarse dentro de un iframe (clickjacking), porque `frame-ancestors` no se puede poner en una `<meta>`.
- `noindex` y `no-referrer`.

## Lo que BlueStar hace con el catálogo (lo trata como no confiable)

Aunque solo el dueño pueda publicar, BlueStar valida todo lo que descarga (`AdminCatalogParser.cs`), por si la cuenta o el
repo se vieran comprometidos o el archivo llegara mal formado:

- `schemaVersion` distinto de 1 → se ignora el catálogo entero. Versiones antiguas de BlueStar nunca leen este archivo.
- Tamaño máximo 2 MB, profundidad JSON limitada, límites de juegos, presets, mods y ajustes.
- URLs solo `https`, sin usuario/contraseña ni puertos raros. Descargas (emulador personalizado y mods): o vienen de
  `coronitaa.github.io` / `github.com/Coronitaa/…` / `raw.githubusercontent.com/Coronitaa/…`, o llevan SHA-256, que se comprueba
  al descargar. Imágenes solo de CDN de Steam o de Coronitaa.
- Rutas (`settingsFile`) solo relativas, sin `..`, unidades, rutas UNC ni streams NTFS, y se vuelve a comprobar que caen dentro
  de la carpeta del juego. Los archivos comprimidos se extraen descartando entradas que salgan de la carpeta destino.
- Ajustes: claves `[A-Za-z0-9_.-]`, valores sin saltos de línea (no se pueden inyectar secciones INI).
- Al instalar, el preset se vuelve a buscar por id en el catálogo validado actual; no se ejecuta nada guardado de antes.
- Si la descarga falla o no valida, BlueStar usa la última copia válida en caché, o ninguna.

## Riesgos que quedan

- Si alguien roba la sesión de GitHub del dueño o un token válido, puede publicar un catálogo malicioso. Las validaciones
  limitan qué puede hacer (solo descargas desde GitHub de Coronitaa o con checksum que él mismo elige), pero un mod o emulador
  malicioso con su SHA-256 correcto se instalaría. Mitigación: 2FA, tokens cortos, revisar el historial de commits.
- Un archivo alojado en `github.com/Coronitaa/…` sin SHA-256 se confía por origen: si se reemplaza el release, BlueStar baja el nuevo.
  Para fijar una versión exacta, poner siempre el SHA-256.
- GitHub Pages cachea unos minutos: un cambio (o una reversión) tarda en llegar a los usuarios.
- Proteger la rama `main` contra force-push y borrado evita que un token robado reescriba el historial.
