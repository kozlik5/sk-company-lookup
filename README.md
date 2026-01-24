# SK Company Lookup

Microservice pre vyhľadávanie slovenských firiem podľa názvu alebo IČO.

## Funkcie

- **Autocomplete** - rýchle vyhľadávanie podľa názvu alebo IČO
- **Fuzzy search** - nájde firmy aj pri preklepoch (pg_trgm)
- **Diakritika** - funguje s aj bez diakritiky
- **RESTful API** - jednoduché integrovanie do akejkoľvek aplikácie

## API Endpoints

### GET /api/search?q=query

Vyhľadávanie firiem.

**Parameters:**
- `q` - hľadaný text (min 2 znaky)
- `limit` - max počet výsledkov (default 20, max 50)
- `includeInactive` - zahrnúť zrušené firmy (default false)

**Response:**
```json
{
  "results": [
    {
      "ico": "12345678",
      "name": "Firma s.r.o.",
      "legalForm": "s.r.o.",
      "city": "Bratislava",
      "isActive": true
    }
  ],
  "count": 15,
  "timing": 12
}
```

### GET /api/company/:ico

Detaily firmy podľa IČO.

### GET /api/stats

Štatistiky databázy (počet firiem).

### GET /health

Health check endpoint.

## Inštalácia

```bash
# Klonovanie
git clone https://github.com/your-repo/sk-company-lookup.git
cd sk-company-lookup

# Inštalácia závislostí
npm install

# Konfigurácia
cp .env.example .env
# Upravte .env s vašimi údajmi

# Spustenie migrácií
npm run migrate

# Development server
npm run dev

# Build pre produkciu
npm run build
npm start
```

## Deployment na Fly.io

```bash
# Vytvorenie app
fly launch

# Pridanie PostgreSQL
fly postgres create --name sk-company-lookup-db
fly postgres attach sk-company-lookup-db

# Nastavenie secrets
fly secrets set ADMIN_API_KEY=your-secret-key

# Deploy
fly deploy

# Spustenie migrácií
fly ssh console -C "node dist/scripts/migrate.js"
```

## Import dát

Dáta sa importujú z [Slovensko.Digital](https://ekosystem.slovensko.digital/otvorene-data) RPO dump.

```bash
# Lokálny import
npm run import

# Cez API (vyžaduje admin API key)
curl -X POST https://sk-company-lookup.fly.dev/admin/import \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: your-admin-key" \
  -d '{"mode": "full"}'
```

## Použitie v iných projektoch

```typescript
// Príklad volania z frontendu
const searchCompanies = async (query: string) => {
  const response = await fetch(
    `https://sk-company-lookup.fly.dev/api/search?q=${encodeURIComponent(query)}`
  );
  return response.json();
};

// Použitie
const results = await searchCompanies('Firma');
console.log(results);
```

## Licencia

MIT
