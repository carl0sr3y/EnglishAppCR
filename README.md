# Tarjetas de idiomas

App para estudiar con tarjetas y repetición espaciada, dividida en **dos partes separadas**:

| Parte | Dirección | Quién la usa | Qué hace |
|---|---|---|---|
| **App** | `/` | Usuarios normales (tú para estudiar, y tus amigos) | Estudiar, ver progreso, descargar informes |
| **Panel de administración** | `/admin` | Solo cuentas de administración | Cargar y publicar tarjetas, gestionar usuarios |

Los usuarios normales **no pueden cargar contenido**: no existe ninguna opción para eso en la app y el servidor lo rechaza. Una cuenta de administración que entra a `/` es enviada automáticamente a `/admin`.

Diseño: fondo de manchas de acuarela que se mueven despacio, paneles de vidrio esmerilado y pestañas con píldora deslizante. Respeta la opción «reducir movimiento» del sistema.

Temas (se cambian con el botón de arriba o en **Cuenta → Apariencia**, y se recuerdan):
- **Oscuro** (por defecto): azul noche con manchas de color.
- **Noche suave:** grises cálidos, menos brillo y menos contraste, sin azul brillante. Pensado para sesiones largas de estudio.
- **Claro.**

Tecnología: Node.js + Express + PostgreSQL. Solo dos dependencias (`express`, `pg`).

## Cómo se usa (flujo recomendado)

1. Entra a `/admin` con la cuenta de administración.
2. **Importar** → «Cargar ruta general (A1.1 y A1.2)» → **Revisar** → **Guardar**. Después, en **Contenido**, revisa cada unidad y **publícala** cuando esté lista.
3. **Importar** → «Cargar ejemplo personal (Semana 1)» → **Guardar**. Es tu plan personalizado: solo lo verán las cuentas con *Plan personalizado*.
4. **Usuarios** → crea **tu usuario normal** con *Plan personalizado* y los de tus amigos con *Plan general*. Tú estudias desde `/` con tu usuario normal.
5. Cuando quieras mejorar con una IA, descarga el informe (pestaña **Informe** de la app), pégalo en la IA y pega en **Importar** lo que te devuelva.

## Todo el estudio dentro de la app

La app cubre el método completo, sin necesidad de PDFs:

| Parte del método | Dónde está |
|---|---|
| Repaso espaciado | Tarjetas y ejercicios |
| Tema nuevo | **Lecciones** (explicación con ejemplos y audio) |
| Producir (escribir y hablar) | **Escritura** (tareas con mínimo de palabras; se guardan para el informe) |
| Leer y escuchar contenido real | **Lecturas** con audio y preguntas |
| Cierre y autoevaluación | **Nota del día** |

La pestaña **Hoy** ordena el día en 5 pasos (repaso, tema nuevo, escribir y hablar, leer y escuchar, cierre), marca lo que ya hiciste y te lleva al siguiente con un toque. Los pasos para los que aún no hay contenido se atenúan y no cuentan.

## Niveles, unidades y audiencias

El contenido se organiza en **niveles** (A1, A2, B1, B2, C1, C2) y dentro de cada nivel en **unidades** numeradas (A1.1, A1.2, A1.3...). Cada unidad trae sus mazos: lección, tarjetas, ejercicios, lectura y escritura. Una unidad dura lo que cada persona tarde: **no es una semana fija**.

- **Ruta recomendada, sin bloqueos:** la app recomienda la siguiente unidad sin completar y la usa para armar «Tu día», pero cualquiera puede abrir cualquier unidad. Cada persona elige su nivel en la pestaña **Ruta**.
- **Avance de una unidad:** un mazo cuenta como hecho cuando leíste la lección, empezaste todas las tarjetas, respondiste los ejercicios, hiciste la lectura o guardaste un texto. La práctica de voz suma práctica, pero no cuenta como avance.
- **Dos audiencias por unidad:**
  - **General:** la ven todos los usuarios. Es la ruta para tus amigos: no hay que personalizar nada por persona.
  - **Personal:** solo la ven las cuentas con **Plan personalizado** (tú), que además reciben la ruta general. Aparece aparte, en «Tu plan personalizado».
- **Plan por usuario:** en **Usuarios** cada cuenta tiene un plan (*General* o *Personalizado*) que cambias cuando quieras.
- **Publicación:** cada unidad tiene su interruptor *Publicada*. Una unidad en borrador no la ve nadie más que la administración.
- **Cargar de a una o todo junto:** el formato permite varias unidades en un mismo texto. Lo recomendable es cargarlas como borrador, revisarlas y publicarlas una por una. Si cargas una unidad que ya existe puedes *agregar* mazos nuevos o *reemplazar* sus mazos (se pierde el progreso de esos mazos).
- La identidad de una unidad es **nivel + número + audiencia**. Por eso puedes tener una A1.1 general y una A1.1 personal a la vez. Una unidad personal no puede pasarse a general si ya existe esa misma general.

Los mazos sin unidad siguen funcionando como antes (aparecen en «Otros mazos» y los ven todos cuando están publicados).

## Práctica de pronunciación

Puedes grabarte diciendo una frase y recibir una nota. Hay cuatro lugares: el botón **Hablar** de «Tu día» (frases de tu unidad), **Pronunciar** en los ejemplos de las lecciones, **Pronunciar** después de responder una tarjeta, y **Leer en voz alta** en lecturas y en tus textos escritos.

**Cómo funciona:** el navegador transcribe tu voz y la app compara palabra por palabra lo que entendió con la frase correcta. Marca en verde lo que dijiste bien, en amarillo lo parecido y en rojo lo que faltó, y te deja escuchar tu grabación.

**Límites (importante):**
- La nota es **aproximada**: mide cuánto de lo que dijiste fue entendido, no la pronunciación sonido por sonido. Una frase bien entendida puede tener acento marcado y una mala puede salir bien por casualidad.
- Depende del reconocimiento de voz de tu navegador: funciona mejor en **Chrome y Edge** (Android y computadora). En Safari o Firefox puede no existir; en ese caso la app te deja grabarte y **autoevaluarte** («Bien», «Más o menos», «Tengo que repetir»).
- El reconocimiento suele necesitar **internet**.
- **Privacidad:** tu audio se queda en tu dispositivo (solo lo usas para escucharte). Al servidor solo van la frase, lo que se entendió y la nota.
- La práctica de voz aparece en el informe para la IA (con tus intentos más bajos), pero **no** cuenta como avance de una unidad.
- La nota sigue una calificación sencilla, probada con casos reales (`test/speech.js`). Una calificación precisa por sonidos requiere un servicio externo de pago por uso; no está incluida.

## En el celular

- Diseñada para pantalla táctil: botones de al menos 40-46 px, textos de 16 px o más (así el teléfono no hace zoom al escribir), respeto de las zonas seguras (muescas y barra inferior) y sin efectos de «pasar el cursor».
- **Teclado:** al escribir, la barra inferior se oculta para no taparte, y el campo se centra solo.
- **Modo ligero** (Cuenta → Rendimiento): quita el desenfoque de vidrio y las animaciones del fondo. Se activa solo en teléfonos con poca memoria, y puedes cambiarlo a mano. Úsalo si la app va lenta o quieres ahorrar batería.
- Se puede **instalar** como app (ver más abajo) y se abre a pantalla completa.
- Se probó con pantallas de 360 a 430 px de ancho, sin desbordes horizontales, pero conviene que la pruebes en tu teléfono real y avises si algo se ve raro.

## Instalarla como app (PWA)

La app se puede instalar en el celular o en la computadora, con su propio logo y a pantalla completa:

- **Android / Chrome / Edge (celular o PC):** abre la app y pulsa **Instalar app** (arriba en el inicio, o en la pestaña **Cuenta**). Si no aparece el botón, usa el menú del navegador → «Instalar app» o «Añadir a la pantalla de inicio».
- **iPhone / iPad (Safari):** toca **Compartir** → **Añadir a pantalla de inicio**.
- Requiere HTTPS, que Railway ya incluye.
- Sin conexión no se puede estudiar (tus tarjetas y progreso viven en el servidor): la app muestra una pantalla de «Sin conexión» con un botón para reintentar.
- Los datos (`/api`) y el panel (`/admin`) nunca se guardan en el dispositivo. El panel de administración no es instalable a propósito.
- Los archivos del logo están en `public/icons/` (`icon.svg` para web y `icon-512.png` para otros usos). Si cambias el diseño, vuelve a generar los PNG con los mismos tamaños.

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

## Actualizar una instalación anterior

Al arrancar, la app migra sola la base de datos: agrega la tabla de unidades, el plan y el nivel de cada usuario, y lo necesario para la práctica de voz. No se pierden usuarios, contraseñas, mazos ni progreso: los mazos existentes quedan como «mazos sin unidad» y los usuarios con plan *General*. Después de actualizar, importa tus unidades y pon tu usuario en *Plan personalizado*. Si vienes de la primera versión (con mazos «compartidos»), también se convierten a «publicados».

## Actualizar desde la primera versión

Si ya tenías la primera versión en GitHub y Railway:

1. Copia los archivos de esta carpeta sobre tu proyecto local (sin borrar la carpeta `.git`).
2. En la terminal de VS Code: `git add .`, `git commit -m "Panel de administración, roles y nuevo diseño"` y `git push`.
3. Railway vuelve a desplegar solo al detectar el push.
4. **La base de datos se migra sola** al arrancar: los mazos que estaban «compartidos» quedan publicados y los privados quedan como borrador. No se pierde progreso ni usuarios.
5. La cuenta que antes era administradora sigue siéndolo: puedes entrar con ella a `/admin`. Si además defines `ADMIN_USERNAME` y `ADMIN_PASSWORD`, se crea una cuenta de administración nueva con esos datos (si el nombre ya existe, se conserva su contraseña actual).
6. Desde `/admin` → Usuarios crea tu usuario normal para estudiar en `/`.

## Probarla en tu computadora

Necesitas PostgreSQL local o una base de Railway.

```
npm install
DATABASE_URL=postgres://usuario:clave@localhost:5432/mibase ADMIN_USERNAME=admin ADMIN_PASSWORD=una-clave-larga npm start
```

Abre http://localhost:3000 (app) y http://localhost:3000/admin (panel).

Pruebas automáticas: `DATABASE_URL=... npm test` (172 comprobaciones: calificación de voz, servidor y unidades). Vacían la base de datos antes de cada prueba y crean usuarios y mazos de prueba, así que úsalas **solo con una base de datos de pruebas**, nunca con la real. `npm test` ya incluye el vaciado (`test/reset.js`), que por seguridad exige `ALLOW_RESET=yes`.

## Panel de administración

- **Contenido:** las **unidades** (con nivel y número, audiencia general/personal, interruptor *Publicada*, ver sus mazos, «Editar unidad como texto» y eliminar) y debajo los **mazos sin unidad**. Cada mazo permite ver su contenido, editarlo como texto y eliminarlo.
- **Importar:** texto o archivo `.txt`, con botones para cargar la ruta general o tu ejemplo personal. *Revisar* comprueba sin guardar, marca la línea de cada error y avisa qué unidades ya existen. Elige qué hacer si la unidad ya existe (agregar o reemplazar).
- **Usuarios:** crear usuarios (con su plan), cambiar el **plan** de cada uno, ver su actividad, descargar su informe, **restablecer contraseña** y eliminar.
- **Cuenta:** cambiar tu contraseña.

## Formato de texto para importar

Hay cinco tipos de contenido y un encabezado de unidad que los agrupa. Se pueden mezclar en un mismo texto:

```
// Los comentarios empiezan con //

@unit A1.1 Título de la unidad     (agrupa los mazos que siguen)
audience: general                  (o personal; opcional)
desc: Descripción corta            (opcional)

@deck Título                      (tarjetas)
inglés | español | frase que contenga la palabra | alternativa1; alternativa2

@exercises Título                 (ejercicios con hueco)
Frase con ___ hueco => respuesta1 / respuesta2 | explicación breve

@lesson Título                    (lección)
## Subtítulo
Un párrafo con **negrita**.
- elemento de lista
> English example | traducción
! Nota o consejo destacado

@reading Título                   (lectura con preguntas)
Párrafo del texto (cada línea es un párrafo).
? Pregunta | opción A; opción B*; opción C | explicación (opcional)

@writing Título                   (tarea de escritura)
Instrucción de la tarea.
min: 25
tip: Un consejo (puede repetirse)
```

Reglas:
- **Tarjeta:** la frase de ejemplo **debe contener** la palabra en inglés (la app la oculta con `_____`). Las alternativas son opcionales y van separadas por `;`.
- **Ejercicio:** las respuestas válidas van separadas por `/`. La explicación es opcional.
- **Lección:** `##` es un subtítulo, `-` una lista, `>` un ejemplo con botón de audio y `!` una nota destacada. Cada línea suelta es un párrafo.
- **Lectura:** las líneas normales son el texto y las que empiezan con `?` son preguntas de opción múltiple. La opción correcta lleva `*` al final; debe haber exactamente una por pregunta, y entre 2 y 6 opciones.
- **Escritura:** `min:` (opcional) son las palabras mínimas para poder guardar; `tip:` son consejos.
- Al comparar respuestas escritas se ignoran mayúsculas, puntos y signos de puntuación.
- Si hay errores, el panel indica en qué línea están antes de guardar nada. **Revisar** comprueba sin guardar.
- **Editar como texto** (en el panel) devuelve cualquier mazo a este formato para corregirlo y volver a importarlo.

El archivo `ejemplo-semana1.txt` trae tu Semana 1 completa: 3 lecciones, 3 mazos de tarjetas, 2 de ejercicios, 1 lectura y 2 tareas de escritura (11 mazos).

## Cómo funciona el repaso espaciado

Cada tarjeta tiene una caja del 1 al 5. Si la aciertas, sube de caja y vuelve a los 1, 3, 7, 14 o 30 días. Si la fallas, vuelve a la caja 1 y reaparece en la misma sesión. Un acierto en el reintento no sube de caja. Cada usuario tiene su propio progreso, y hay un límite diario de tarjetas nuevas por mazo.

## Informes para compartir con una IA

Desde la app (pestaña **Informe**) cada usuario descarga el resumen de **hoy** o de la **semana** (`.md`, o JSON desde el panel). Incluye instrucciones para la IA, el formato de importación de los 5 tipos, los aciertos por mazo, los errores más frecuentes con lo que escribió el usuario, las lecciones y lecturas hechas (con su resultado), **los textos escritos para que la IA los corrija**, la práctica de pronunciación, el estado de las cajas y sus notas.

## Seguridad y límites

- Las contraseñas se guardan con scrypt (nunca en texto plano). Las sesiones duran 30 días y la cookie es HttpOnly.
- Todas las acciones de administración se comprueban **en el servidor** (no basta con ocultar botones).
- El inicio de sesión limita los intentos repetidos desde una misma dirección.
- Si alguien olvida su contraseña, la administración puede restablecerla desde el panel.
- Quien administra la base de datos puede ver los datos de todos los usuarios. Conviene avisárselo a tus amigos.
- Está pensada para un grupo pequeño de usuarios, no para miles.
