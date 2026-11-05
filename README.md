# Tarjetas de idiomas

App para estudiar con tarjetas y repetición espaciada, dividida en **dos partes separadas**:

| Parte | Dirección | Quién la usa | Qué hace |
|---|---|---|---|
| **App** | `/` | Usuarios normales (tú para estudiar, y tus amigos) | Estudiar, ver progreso, descargar informes |
| **Panel de administración** | `/admin` | Solo cuentas de administración | Cargar y publicar tarjetas, gestionar usuarios |

Los usuarios normales **no pueden cargar contenido**: no existe ninguna opción para eso en la app y el servidor lo rechaza. Una cuenta de administración que entra a `/` es enviada automáticamente a `/admin`.

Diseño: fondo de manchas de acuarela que se mueven despacio, paneles de vidrio esmerilado, pestañas con píldora deslizante, modo oscuro por defecto y modo claro. Respeta la opción «reducir movimiento» del sistema.

Tecnología: Node.js + Express + PostgreSQL. Solo dos dependencias (`express`, `pg`).

## Cómo se usa (flujo recomendado)

1. Entra a `/admin` con la cuenta de administración.
2. **Importar** → pega tu texto (o pulsa «Cargar ejemplo (Semana 1)») → **Revisar** → **Guardar mazos**. Si los guardas como borrador, los publicas luego con el interruptor en **Contenido**.
3. **Usuarios** → crea **tu usuario normal** (por ejemplo `carlos`) y los de tus amigos. Tú estudias desde `/` con ese usuario normal.
4. Cuando quieras mejorar con una IA, descarga el informe (desde la app, pestaña **Informe**), pégalo en la IA y pega en **Importar** lo que te devuelva.

## Variables de entorno

| Variable | Obligatoria | Para qué sirve |
|---|---|---|
| `DATABASE_URL` | Sí | Conexión a PostgreSQL |
| `ADMIN_USERNAME` | Sí | Usuario de la cuenta de administración (se crea sola al arrancar) |
| `ADMIN_PASSWORD` | Sí | Contraseña inicial de esa cuenta (mínimo 8 caracteres). Cámbiala luego en `/admin` → Cuenta |
| `NODE_ENV` | Recomendada | Pon `production` en Railway (activa cookies seguras) |
| `INVITE_CODE` | No | Si lo defines, el registro público exige este código |
| `REGISTRATION` | No | Pon `closed` para cerrar el registro público: solo la administración crea usuarios |
| `PGSSL` | No | Pon `true` si usas la URL **pública** de la base de datos |

Importante: el registro público **nunca** crea administradores. La cuenta de administración solo se crea con `ADMIN_USERNAME` y `ADMIN_PASSWORD`.

## Subirla a Railway

1. **Sube la carpeta a GitHub** (repositorio nuevo). Desde la terminal de VS Code:
   ```
   git init
   git add .
   git commit -m "Tarjetas de idiomas"
   git branch -M main
   git remote add origin https://github.com/TU_USUARIO/tarjetas-idiomas.git
   git push -u origin main
   ```
2. En Railway: **New Project → Deploy from GitHub repo** y elige el repositorio.
3. En el mismo proyecto agrega la base de datos: **New → Database → Add PostgreSQL**.
4. Abre el servicio de la app → **Variables** y crea:

   | Variable | Valor |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (referencia al servicio de Postgres; si tu servicio se llama distinto, usa ese nombre) |
   | `NODE_ENV` | `production` |
   | `ADMIN_USERNAME` | por ejemplo `carlos-admin` |
   | `ADMIN_PASSWORD` | una contraseña larga que solo tú sepas |
   | `INVITE_CODE` | un código que tú inventes (opcional) |

5. En **Settings → Networking → Generate Domain** para obtener el enlace público.
6. Entra a `https://TU-ENLACE/admin`, inicia sesión y sigue el flujo recomendado de arriba.

Notas:
- Los nombres exactos de los menús de Railway pueden cambiar con el tiempo. Si algo no coincide, busca la opción equivalente.
- La app crea sus tablas sola la primera vez que arranca.
- Cuando tus amigos ya tengan cuenta, puedes poner `REGISTRATION=closed` para que nadie más pueda registrarse.
- Para compartir la app, pasa a tus amigos el enlace **sin** `/admin` (y el código de invitación si lo usas, o créales tú la cuenta desde el panel).

## Probarla en tu computadora

Necesitas PostgreSQL local o una base de Railway.

```
npm install
DATABASE_URL=postgres://usuario:clave@localhost:5432/mibase ADMIN_USERNAME=admin ADMIN_PASSWORD=una-clave-larga npm start
```

Abre http://localhost:3000 (app) y http://localhost:3000/admin (panel).

Prueba automática: `DATABASE_URL=... npm test`. Crea usuarios y mazos de prueba, así que úsala **solo con una base de datos de pruebas**, nunca con la real.

## Panel de administración

- **Contenido:** lista de mazos con interruptor Publicado/Borrador, vista previa de las tarjetas, «Editar como texto» (carga el mazo en el importador para corregirlo) y eliminar.
- **Importar:** texto o archivo `.txt`, botón «Revisar» (comprueba sin guardar y marca la línea de cada error) y «Guardar mazos».
- **Usuarios:** crear usuarios, ver su actividad de la semana, descargar el informe de cada uno, **restablecer contraseña** (genera una temporal de un solo uso y cierra sus sesiones) y eliminar.
- **Cuenta:** cambiar tu contraseña.

## Formato de texto para importar

```
// Los comentarios empiezan con //
@deck Título del mazo
inglés | español | frase de ejemplo que contenga la palabra | alternativa1; alternativa2

@exercises Título de los ejercicios
Frase con ___ hueco => respuesta1 / respuesta2 | explicación breve
```

- Cada mazo empieza con `@deck` (tarjetas) o `@exercises` (ejercicios). En un mismo texto puede haber varios mazos.
- En una tarjeta, la frase de ejemplo **debe contener** la palabra en inglés (la app la oculta con `_____`).
- Las alternativas de una tarjeta van separadas por `;` y son opcionales.
- Las respuestas válidas de un ejercicio van separadas por `/`. La explicación es opcional.
- Al comparar respuestas se ignoran mayúsculas, puntos y signos de puntuación.
- Si hay errores, la app indica en qué línea están antes de guardar nada.

## Cómo funciona el repaso espaciado

Cada tarjeta tiene una caja del 1 al 5. Si la aciertas, sube de caja y vuelve a los 1, 3, 7, 14 o 30 días. Si la fallas, vuelve a la caja 1 y reaparece en la misma sesión. Un acierto en el reintento no sube de caja. Cada usuario tiene su propio progreso, y hay un límite diario de tarjetas nuevas por mazo.

## Informes para compartir con una IA

Desde la app (pestaña **Informe**) cada usuario descarga el resumen de **hoy** o de la **semana** (`.md`, o JSON desde el panel). Incluye instrucciones para la IA, el formato de importación, los aciertos por mazo, los errores más frecuentes con lo que escribió el usuario, el estado de las cajas y sus notas.

## Seguridad y límites

- Las contraseñas se guardan con scrypt (nunca en texto plano). Las sesiones duran 30 días y la cookie es HttpOnly.
- Todas las acciones de administración se comprueban **en el servidor** (no basta con ocultar botones).
- El inicio de sesión limita los intentos repetidos desde una misma dirección.
- Si alguien olvida su contraseña, la administración puede restablecerla desde el panel.
- Quien administra la base de datos puede ver los datos de todos los usuarios. Conviene avisárselo a tus amigos.
- Está pensada para un grupo pequeño de usuarios, no para miles.
