# Nodos de neurodesarrollo

Web para encontrar el nodo de neurodesarrollo (pediatras de desarrollo infantil del GCBA) más cercano al domicilio de un paciente. TypeScript + Vite, sin backend y sin claves de API.

## Estructura

| Ruta | Para qué sirve |
| --- | --- |
| `public/nodos.json` | La lista de nodos. Es lo único que hay que editar para agregar o sacar nodos. |
| `index.html` | Estructura de la página. |
| `src/main.ts` | Interfaz: buscador, mapa (Leaflet) y listado. |
| `src/geocoder.ts` | Interpreta la dirección escrita y la ubica en el mapa. |
| `src/styles.css` | Estilos. |
| `tests/` | Pruebas con Vitest. |
| `.github/workflows/deploy.yml` | Compila, prueba y publica en GitHub Pages en cada push a `main`. |

## Desarrollo

Requiere Node 22.12 o posterior.

```sh
npm install
npm run dev        # servidor local con recarga
npm test           # pruebas
npm run build      # chequeo de tipos + compilación en dist/
npm run preview    # sirve dist/ para revisarla
```

## Agregar, editar o sacar nodos

Cada nodo es un objeto dentro de `public/nodos.json`:

```json
{
  "name": "CeSAC 42",
  "neighborhood": "Boedo",
  "hospital": "Htal. Durand",
  "doctor": "Dra. Silvina Patrone",
  "address": "Av. La Plata 2241, CABA",
  "phone": "11 1234-5678",
  "notes": "Turnos por el 147"
}
```

Solo `name` y `address` son obligatorios. La dirección va en texto, terminada en `CABA` o en el barrio, la localidad o el partido. La página la ubica sola la primera vez y guarda el resultado en el navegador durante 30 días.

Se puede editar directo desde la web de GitHub: al guardar el cambio, el workflow vuelve a publicar el sitio.

### Si un nodo queda mal ubicado

1. Abrí la página con `#admin` al final de la URL.
2. Arrastrá el nodo al lugar correcto. Debajo de cada nodo figura cómo se lo ubicó.
3. Tocá **Copiar JSON** y reemplazá con eso el contenido de `public/nodos.json`.

Así el nodo queda con `lat` y `lon` fijos. Conviene hacerlo una vez con todos: el mapa carga más rápido y no depende de los servicios de direcciones para mostrar los nodos.

## Publicar en GitHub Pages

1. Subí el proyecto a un repositorio en GitHub (sin `node_modules` ni `dist`, que ya están en `.gitignore`).
2. En **Settings → Pages**, en *Source* elegí **GitHub Actions**.
3. Cada push a `main` corre las pruebas, compila y publica en `https://TU-USUARIO.github.io/NOMBRE-DEL-REPO/`. También se puede lanzar a mano desde la pestaña **Actions**.

Si fallan las pruebas o la compilación, no se publica nada y queda online la versión anterior.

La compilación usa rutas relativas (`base: './'` en `vite.config.ts`), así que `dist/` funciona tanto en la subcarpeta de GitHub Pages como en la raíz de cualquier otro hosting estático. En Cloudflare Pages o Netlify: comando `npm run build`, carpeta `dist`.

El sitio queda público: cualquiera con la URL ve los nodos y los nombres de las profesionales. Si hace falta restringirlo, Cloudflare Pages con Cloudflare Access permite pedir un login por mail.

## Cómo busca las direcciones

1. **Limpia el texto**: saca piso, depto, código postal y "Argentina"; entiende "N°", "al 5000" y esquinas; reconoce CABA, sus barrios y los partidos y localidades del AMBA, con o sin coma y con errores de tipeo.
2. **Consulta en paralelo** a Georef (Datos Argentina) y USIG (Ciudad), limitando la búsqueda a la zona detectada. Si no hay resultados, reintenta con variantes ("Gral." → "General", "1°" → "Primo").
3. **Si en esa zona no aparece**, busca en el resto del AMBA y muestra lo que encuentre como opciones.
4. **Si tampoco**, prueba con OpenStreetMap y lo marca como aproximado.
5. **Si no hay nada**, avisa si la calle existe pero la altura no, sugiere calles de nombre parecido y ofrece marcar el punto en el mapa.

Cuando una dirección existe en varios lugares ("Libertador 500" está en CABA y en varios partidos), muestra las opciones en la lista y en el mapa para elegir. El pin del domicilio siempre se puede arrastrar para corregirlo.

Las distancias son en línea recta. El botón **Cómo llegar** abre Google Maps con el recorrido en transporte público.

## Privacidad

La dirección del paciente no se guarda en ningún lado ni queda en la URL. Se envía, sin nombre, a los servicios de direcciones para ubicarla. Google Maps recibe el punto de partida solo si se toca **Cómo llegar**. En el navegador se guardan únicamente las ubicaciones de los nodos.

## Servicios externos

| Servicio | Uso |
| --- | --- |
| [Georef](https://www.argentina.gob.ar/georef) | Direcciones de todo el país. Gratis, sin clave. |
| [USIG](https://usig.buenosaires.gob.ar/) | Direcciones de CABA y AMBA (por JSONP si el navegador bloquea la consulta directa). |
| [Nominatim](https://operations.osmfoundation.org/policies/nominatim/) | Último recurso. Uso liviano, una consulta por búsqueda. |
| [OpenStreetMap](https://operations.osmfoundation.org/policies/tiles/) | Mapa base. Uso liviano con atribución. |
| [Leaflet](https://leafletjs.com/) | Mapa. Viene de npm y queda incluido en la compilación. |

Son servicios públicos que pueden cambiar o interrumpirse. Si fallan, la página lo avisa y permite marcar el punto a mano. Si el tráfico crece mucho, conviene usar otro proveedor de mapas.
