# Portable RFID Agent build

Bu papka **offline ishlaydigan portable paket** yasash uchun.

## Talablar

- bash
- curl
- tar (xz qo‘llab-quvvatlashi bilan)
- rsync

## Build

```
./build.sh
```

ARM64 ham kerak bo‘lsa:

```
RFID_PORTABLE_ARCHES=all ./build.sh
```

Natija:

- `dist/rfid-agent/` — enterprise’ga yuborish uchun tayyor papka

Ixtiyoriy:

```
tar -czf dist/rfid-agent.tar.gz -C dist rfid-agent
```
