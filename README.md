# Tarjetas de idiomas

App sencilla para estudiar con tarjetas y repetición espaciada.

- Inicio de sesión para varios usuarios (cada uno con su propio progreso).
- Importa contenido desde texto o un archivo `.txt` en un formato simple y lo convierte en tarjetas y ejercicios.
- Descarga informes del día o de la semana, listos para pegar en una IA.
- Modo oscuro por defecto.

Tecnología: Node.js + Express + PostgreSQL. Solo dos dependencias (`express`, `pg`).

## Qué hay en la carpeta

| Archivo | Para qué sirve |
|---|---|
| `server.js` | Servidor y API (cuentas, mazos, estudio, informes) |
| `parser.js` | Lee el formato de texto y detecta errores por línea |
| `public/index.html` | Toda la interfaz |
| `ejemplo-semana1.txt` | Tu Semana 1 (30 palabras y 16 ejercicios) listo para importar |
| `test/smoke.js` | Prueba automática del servidor |

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
   | `INVITE_CODE` | un código que tú inventes (opcional, recomendado) |
   | `ADMIN_USERNAME` | tu usuario (opcional; si no lo pones, el primero que se registre es admin) |

5. En **Settings → Networking → Generate Domain** para obtener el enlace público.
6. Abre el enlace y **crea tu cuenta primero**, con el mismo usuario que pusiste en `ADMIN_USERNAME`.
7. Importa `ejemplo-semana1.txt` marcando «Compartir con todos» y ya puedes pasarle el enlace y el código a tus amigos.

Notas:
- Los nombres exactos de los menús de Railway pueden cambiar con el tiempo. Si algo no coincide, busca la opción equivalente.
- Si usas la URL **pública** de la base de datos en vez de la interna, agrega la variable `PGSSL=true`.
- La app crea sus tablas sola la primera vez que arranca.
- Cuando tus amigos ya estén registrados, puedes cambiar o quitar `INVITE_CODE` para que nadie más pueda crear cuentas.

## Probarla en tu computadora

Necesitas PostgreSQL local o una base de Railway.

```
npm install
DATABASE_URL=postgres://usuario:clave@localhost:5432/mibase npm start
```

Luego abre http://localhost:3000. Para correr la prueba automática: `DATABASE_URL=... npm test`. Crea usuarios y mazos de prueba, así que úsala **solo con una base de datos de pruebas**, nunca con la real.

## Formato de texto para importar

```
// Los comentarios empiezan con //
@deck Título del mazo
inglés | español | frase de ejemplo que contenga la palabra | alternativa1; alternativa2

@exercises Título de los ejercicios
Frase con ___ hueco => respuesta1 / respuesta2 | explicación breve
```

Reglas:
- Cada mazo empieza con `@deck` (tarjetas) o `@exercises` (ejercicios). En un mismo texto puede haber varios mazos.
- En una tarjeta, la frase de ejemplo **debe contener** la palabra en inglés (la app la oculta con `_____`).
- Las alternativas de una tarjeta van separadas por `;` y son opcionales (por ejemplo, `watercolor | acuarela | ... | watercolour`).
- Las respuestas válidas de un ejercicio van separadas por `/`. La explicación es opcional.
- Al comparar respuestas se ignoran mayúsculas, puntos y signos de puntuación.
- Si hay errores, la app te dice en qué línea están antes de guardar nada. El botón **Revisar** comprueba el texto sin guardarlo.

## Cómo mejorar con una IA

1. Estudia durante unos días y escribe tu nota del día.
2. Descarga el **informe semanal** (o pulsa «Copiar informe semanal»).
3. Pégalo en la IA que prefieras. El informe ya incluye las instrucciones y el formato de importación.
4. La IA te devolverá ejercicios y tarjetas nuevos sobre tus errores. Pégalos en «Importar contenido» y pulsa **Revisar** y luego **Guardar mazos**.

El informe incluye: aciertos por mazo, errores más frecuentes con lo que escribiste, estado de las cajas de repetición espaciada y tus notas. También hay versión JSON.

## Cómo funciona el repaso espaciado

Cada tarjeta tiene una caja del 1 al 5. Si la aciertas, sube de caja y vuelve a los 1, 3, 7, 14 o 30 días. Si la fallas, vuelve a la caja 1 y reaparece en la misma sesión. Un acierto en el reintento no sube de caja (cuenta como repaso, no como recuerdo).

## Seguridad y límites

- Las contraseñas se guardan con scrypt (nunca en texto plano). Las sesiones duran 30 días y la cookie es HttpOnly.
- El inicio de sesión limita los intentos repetidos desde una misma dirección.
- No hay recuperación de contraseña por correo. Si alguien la olvida, la opción más simple es que cree otra cuenta con otro usuario.
- Quien administra la base de datos (tú) puede ver los datos de todos los usuarios. Conviene avisárselo a tus amigos.
- Está pensada para un grupo pequeño de usuarios, no para miles.
