# yazio-mcp

Remote-MCP-Server (Streamable HTTP) für die Ernährungs-App [YAZIO](https://www.yazio.com),
deploybar auf Cloudflare Workers.

> **Inoffiziell.** YAZIO hat keine öffentliche API. Der Server nutzt die private API der
> Mobile-App (`https://yzapi.yazio.com`), die sich jederzeit ändern kann. Die Nutzung
> unterliegt den Nutzungsbedingungen von YAZIO.

## Tools

| Tool                                               | Beschreibung                                                                                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_food(query, limit?, country?)`             | Produkte suchen (Name, Marke oder EAN), mit Nährwerten pro 100 g/ml und Standardportion                                                                       |
| `add_meal(product_id, amount_g, meal_type, date?)` | Eintrag hinzufügen; `meal_type` ist `breakfast`, `lunch`, `dinner` oder `snack`                                                                               |
| `get_day(date?)`                                   | Einträge eines Tages nach Mahlzeit, Summen pro Mahlzeit und Tag, Kalorienziel und Restkalorien                                                                |
| `delete_entry(entry_id)`                           | Eintrag löschen (die `entry_id` aus `get_day`, nicht die `product_id`)                                                                                        |
| `get_goals(date?)`                                 | Aktuelle Ziele: Kalorien, Makros (g und %), Kalorienverteilung pro Mahlzeit, Wasser, Schritte und Zielgewicht                                                 |

Datumsangaben haben das Format `YYYY-MM-DD`. Ohne Datum gilt „heute“ in der Zeitzone
`YAZIO_TIMEZONE`.

**`update_goals` fehlt absichtlich:** Die YAZIO-API hat keinen Schreib-Endpunkt für Ziele.
`/user/goals` kann nur gelesen werden, und keines der untersuchten Community-Projekte hat
einen Weg gefunden, die Ziele zu ändern. Ziele lassen sich nur in der App ändern.

## Zugriffsschutz

Jede MCP-Anfrage muss das Secret `MCP_AUTH_TOKEN` mitschicken, auf eine von zwei Arten:

- **Header:** `POST https://<worker>/mcp` mit `Authorization: Bearer <MCP_AUTH_TOKEN>`
- **Geheimer Pfad:** `https://<worker>/mcp/<MCP_AUTH_TOKEN>`, für Clients ohne eigene Header,
  zum Beispiel Custom Connectors in Claude

Ohne gültiges Token antwortet der Server mit `401` (Header) bzw. `404` (Pfad). Ist
`MCP_AUTH_TOKEN` nicht gesetzt oder kürzer als 16 Zeichen, lehnt er jede MCP-Anfrage ab.
`/health` ist ohne Token erreichbar und liefert nur `ok`.

## Deploy auf Cloudflare

Voraussetzungen: Node.js 22+ und ein Cloudflare-Account.

```bash
npm install
npx wrangler login

# Secrets setzen (werden interaktiv abgefragt)
npx wrangler secret put YAZIO_EMAIL
npx wrangler secret put YAZIO_PASSWORD
openssl rand -hex 32            # Ausgabe als MCP_AUTH_TOKEN verwenden
npx wrangler secret put MCP_AUTH_TOKEN

# Optional, empfohlen: Token-Cache über Isolates hinweg
npx wrangler kv namespace create YAZIO_TOKEN_CACHE
# Die ausgegebene id im [[kv_namespaces]]-Block in wrangler.toml eintragen
# (Block dort einkommentieren)

npm run deploy
```

Danach in den MCP-Client eintragen:

```text
https://yazio-mcp.<dein-subdomain>.workers.dev/mcp/<MCP_AUTH_TOKEN>
```

oder `https://…/mcp` mit dem Header `Authorization: Bearer <MCP_AUTH_TOKEN>`.

### Konfiguration (`[vars]` in `wrangler.toml`)

| Variable            | Standard        | Bedeutung                                                                                     |
| ------------------- | --------------- | --------------------------------------------------------------------------------------------- |
| `YAZIO_TIMEZONE`    | `Europe/Berlin` | Zeitzone für „heute“ und für Zeitstempel neuer Einträge (YAZIO speichert lokale Zeit)          |
| `YAZIO_API_VERSION` | `v18`           | API-Version. v15–v19 funktionieren ohne App-User-Agent, ab v20 ist `YAZIO_USER_AGENT` nötig     |
| `YAZIO_USER_AGENT`  | –               | Optionaler User-Agent der YAZIO-App für neuere API-Versionen                                  |
| `YAZIO_COUNTRY`     | aus dem Profil  | Lebensmittel-Markt für `search_food`, z. B. `DE`, `AT`, `CH`                                    |
| `YAZIO_LOCALE`      | aus dem Profil  | Locale für `search_food`, z. B. `de_DE`                                                        |

### Token-Handling

Der Server meldet sich per OAuth-Password-Grant mit `YAZIO_EMAIL` und `YAZIO_PASSWORD` an.
Das Token (48 h gültig) wird im Isolate gecacht und, wenn der KV-Namespace
`YAZIO_TOKEN_CACHE` gebunden ist, auch in KV (Schlüssel: SHA-256 der E-Mail). Kurz vor
Ablauf wird es per Refresh-Token erneuert. Scheitert das, meldet sich der Server erneut mit
dem Passwort an. Nach einem `401` erneuert er das Token einmal und wiederholt die Anfrage.

## Entwicklung

```bash
cp .dev.vars.example .dev.vars  # lokale Secrets eintragen, nie committen
npm run dev                     # wrangler dev auf http://localhost:8787
npm run typecheck
npm test                        # Tests mit gefälschter YAZIO-API, ohne echte Zugangsdaten
```

## Quellen zur inoffiziellen API

- [juriadams/yazio](https://github.com/juriadams/yazio) (npm-Paket `yazio`): Auth-Flow, Diary-, Produkt- und Ziel-Endpunkte
- [yazio-community/yazio-api-specification](https://github.com/yazio-community/yazio-api-specification): OpenAPI-Beschreibung der privaten API
- [nichtlegacy/yazio-mcp](https://github.com/nichtlegacy/yazio-mcp): live geprüfte API-Notizen (Versionen, Nährwerte pro 1 g, Lösch-Body, fehlende Ziel-Schreibmethode)

## Lizenz

MIT, siehe [LICENSE](./LICENSE). Hervorgegangen aus einem Fork von
[hevy-mcp](https://github.com/chrisdoc/hevy-mcp).
