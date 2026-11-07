# Catálogo de singles

Cartas sueltas de los juegos soportados, con su precio de referencia en USD. Viene de
TCGplayer vía [TCGCSV](https://tcgcsv.com). La app **nunca** consulta al proveedor: todo
se lee de la base de cada tienda.

## Cómo fluye

```
TCGCSV ──(1 vez al día)──▶ proyecto central kananpos-catalogo ──(copia)──▶ base de cada tienda
                           tcg_games / tcg_sets / tcg_products            solo sus juegos activos
                           tcg_prices / tcg_price_history                 (tcg_* sin extended_data)
                           catalog_sync_runs
```

1. **Descarga** (proveedor → central). Solo los juegos que tiene activos **al menos una
   tienda** (`store_tcg_settings`). Si nadie vende Lorcana, no se descarga Lorcana.
   - Primero revisa `last-updated.txt`: si TCGCSV no cambió desde la última corrida
     buena, no baja nada (corrida `skipped`).
   - Por set: los **productos** solo se vuelven a bajar si el set cambió (`modifiedOn`);
     los **precios**, siempre. Peticiones una tras otra, con 150 ms de pausa y User-Agent
     `KananPOS-CatalogSync/1.0.0`.
   - Si falla un set, se anota en la corrida (`errors`) y sigue con el siguiente. Una
     corrida `partial` no marca el juego como al día, así que la siguiente reintenta.
2. **Copia** (central → cada tienda). Solo sus juegos activos y solo lo que cambió desde
   su última copia (marcas `products_copied_through` / `prices_copied_through`).
   `tcg_games.catalog_status` dice `downloading` → `ready` (o `error`).

3. **Historial** (central → cada tienda). Solo de las cartas que la tienda tiene en
   inventario: completo para las que acaban de entrar y los últimos 3 días para las demás.
   La app lo muestra en la vista general del producto.

Todo es upsert: correrla dos veces no duplica nada. Cada descarga y cada copia queda en
`catalog_sync_runs` del central (`npm run singles -- corridas`).

**Solo singles** (`isSingle.ts`): no entra lo que tiene `Rarity = "Code Card"`; entra lo
que tiene `Number`, o una `Rarity` distinta de `"None"`; lo demás es sellado y no se
importa.

**Precios:** siempre en USD. `tcg_prices` guarda el último por carta + subtipo (Normal,
Foil, Holofoil…). El historial guarda solo los cambios de market/mid (el precio de un día
es la última fila hasta ese día). En las tiendas la app no lee `tcg_prices` directo: solo
por funciones con límite. No hay exportación ni API de precios de mercado en bloque.

**Peticiones:** con los 11 juegos activos, la primera carga es de unas 4,500 peticiones
(por ejemplo, Pokémon completo son 441), y un día normal, unas 2,300. El límite de
TCGCSV es de 10,000 al día.

## Producto sellado y accesorios

El catálogo de sellado (el del alta por código de barras) también pasa por el central:
`npm run singles -- sellado` junta las fuentes de todas las tiendas
(`enabled_catalog_sources`), las descarga una vez con `scripts/importar-catalogo.mjs
--central` (peticiones de una en una con pausa) a la tabla `catalog_products` del
central y copia a cada tienda solo las suyas. Lo corre el workflow **Importar catálogo
TCG** cada lunes; también `npm run clientes -- catalogo` y el alta de un cliente.

## Correrla

Automática: workflow **Sincronizar singles** (`.github/workflows/sincronizar-singles.yml`),
cada día a las 05:00 de CDMX (11:00 UTC). Secrets: `SUPABASE_ACCESS_TOKEN` y `CATALOGO_REF`.

A mano (`.env.clientes` con `SUPABASE_ACCESS_TOKEN` y `CATALOGO_REF`):

```bash
npm run singles -- sync                          # lo de todas las noches
npm run singles -- sync --juego magic            # solo Magic
npm run singles -- sync --ref <id> --juego lorcana   # carga inicial de una tienda
npm run singles -- sync --forzar                 # bajar todo aunque TCGCSV no haya cambiado
npm run singles -- sync --solo-copiar            # sin descargar: solo copiar a las tiendas
npm run singles -- juegos                        # lista curada y su categoryId
npm run singles -- muestra --juego pokemon --sets 2  # qué entra y qué no (no guarda nada)
npm run singles -- sellado                       # catálogo de sellado vía el central (lunes)
npm run singles -- corridas                      # últimas corridas
npm run singles -- migrar-central                # migraciones de supabase/catalogo
```

También en GitHub: **Actions → Sincronizar singles → Run workflow** (juego, tienda, forzar).

### Primera vez

1. Crea el proyecto `kananpos-catalogo` en Supabase (Pro) y pon su ID en `CATALOGO_REF`
   (en `.env.clientes` y como secret de GitHub).
2. `npm run singles -- migrar-central`.
3. `npm run clientes -- migrar` (crea las tablas `tcg_*` en cada tienda).
4. `npm run singles -- sync`: carga la lista de juegos en cada tienda. Las descargas
   empiezan cuando una tienda activa un juego (Configuración → Singles y juegos) o con
   `--juego`.
5. Para la carga inmediata al activar un juego: `GITHUB_DISPATCH_TOKEN` en
   `.env.clientes` (token fino de GitHub, "Actions: read and write" solo en este
   repositorio) y `npm run clientes -- funciones` (despliega `activar-juego` y le pone
   el secret). Sin él, el juego llega en la siguiente actualización automática.

## Agregar un juego

Súmalo a `juegos.json` con su `slug` y el nombre de la categoría en TCGplayer (`name` o
`displayName` de <https://tcgcsv.com/tcgplayer/categories>). El `categoryId` se busca
solo. Con `npm run singles -- juegos` verificas que lo encuentre.

## Cambiar de proveedor

El resto del código solo conoce la interfaz `PriceProvider` (`types.ts`):
`lastUpdated`, `listGames`, `listSets`, `listProducts` y `listPrices`, con todo
normalizado a nuestros modelos y los IDs de TCGplayer (`tcgplayer_product_id`) para
cruzar fuentes.

1. Implementa la clase en `providers/` (`TcgApiProvider` ya tiene la estructura).
2. Regístrala en `providers/index.ts`.
3. Cambia la variable `CATALOG_PROVIDER` (variable del repositorio en GitHub, o en tu
   `.env.clientes`). Las llaves van solo en secrets del servidor (`TCGAPI_KEY`), nunca en
   el frontend ni en variables `VITE_`.

## Pruebas

```bash
npm test                                          # is_single, proveedor, sincronización y precio sugerido (vitest)
PGHOST=/tmp PGPORT=54329 supabase/tests/run.sh    # SQL: upsert idempotente del central, permisos, búsqueda
                                                  # filtrada por juegos activos, alta con lotes y aplicar precios
```
