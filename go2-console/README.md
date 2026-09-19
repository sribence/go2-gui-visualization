# Go2 Console

Operátori konzol a Unitree Go2-höz. Side quest a `C:\dev\NERO_GO2\mission-control` mellé:
**az a projekt a képességeket építette meg, ez a felületet adja hozzájuk.**

A teljes helyzetelemzés, a hiányelemzés és a tervezés: **[ANALYSIS.md](ANALYSIS.md)**.

---

## Indítás

```powershell
cd C:\dev\go2-console
pip install -r requirements.txt
python run.py
```

Kiírja a localhost- és a LAN-címet. Telefonról/tabletről ugyanarról a WiFi-ről a LAN-cím
nyitható meg. Ha a tűzfal blokkolja (rendszergazdaként, egyszer):

```powershell
New-NetFirewallRule -DisplayName "go2-console" -Direction Inbound -LocalPort 9200 -Protocol TCP -Action Allow -Profile Private
```

Így **demó backenddel** fut: szintetikus robot, térkép, öt kamera, küldetések, incidensek.
Nincs benne robot-kliens, DDS vagy WebRTC import — fizikai robotot nem tud mozgatni.

## Éles mód

```powershell
$env:MC_API_TOKEN = "ugyanaz-amivel-a-core-indult"
python run.py --live
```

Ilyenkor ugyanez a felület a **valódi mission-control pillérekhez** köt
(`server/live_backend.py`). A fejlécben a jelvény `demó` helyett **ÉLES**-re vált, hogy a
kettő soha ne legyen összetéveszthető.

Előfeltétel: futnak a pillérek, és az `MC_API_TOKEN` megegyezik azzal, amivel a `core`
indult — különben a core minden írási művelete 503-at ad (ez szándékos: a hiányzó
konfiguráció zárva bukik, nem nyitva).

Felülbírálható végpontok env-változóval: `CORE_URL`, `MAPPING_URL`, `NAVIGATION_URL`,
`ORCHESTRATION_URL`, `SENSORS_URL`, `MULTICAM_URL`, `AUDIO_URL`, `BLACKBOX_URL`.

**Két elv, amit az éles adapter szigorúan tart** (mindkettő a 2026-09-10-i audit tanulsága):

1. **A megszakadt kapcsolat nem néz ki valós adatnak.** Ha a core nem válaszolt mostanában,
   a póz/akku/IMU `null` lesz és a felületen `--`/`n/a` jelenik meg — nem esik vissza
   nullára. Pontosan ez tette korábban megkülönböztethetetlenné a lecsatlakozott robotot
   egy origóban álló, lemerült robottól.
2. **A felület nem vár az upstreamre.** Egy háttérszál gyorsítótárazza az állapotot; minden
   kérés a cache-ből olvas. Egy lassú pillér a saját paneljét rontja el, nem az egész konzolt.

Amit az éles adapter külön megold: a `mapping` bolyongása és a `navigation` pont-navigációja
ugyanazt a robotot vezényli, és egyik sem tud a másikról. A konzol az egyetlen hely, ahonnan
mindkettő látszik, ezért **ő dönt**: célkijelöléskor leállítja a térképezést, térképezés
indításakor megszakítja a navigációt.

Ami éles módban még nem elérhető, mert a `core` nem exponálja: gait/testtartás váltás,
motorhőmérsékletek, sebesség-visszajelzés. Ezek `n/a`-ként jelennek meg, nem kitalált
értékkel.

---

## Elrendezés

1920×1080-ra tervezve, négy állandó zónával:

- **Fejléc** — kapcsolat+késleltetés, akku, motorhőmérséklet, üzemmód, nav-állapot,
  élesítés, és az **E-STOP**, ami minden modulban látszik. Gyorsbillentyű: `Szóköz` / `Esc`.
- **Bal sáv** — a tíz modul.
- **Munkaterület** — az aktív modul.
- **Jobb inspektor** — az adott modul **összes hangolható paramétere**.
- **Lábléc** — folyamatos eseménynapló, súlyosság szerint szűrve.

## Modulok

| Modul | Mit tud |
|---|---|
| **Áttekintés** | Telemetria-kártyák, minitérkép kattints-a-célért, kameraképek, aktív riasztások, gyorsparancsok |
| **Térkép és navigáció** | 2D raszter-térkép pan/zoom, 3D digitális iker, cél kijelölés, **waypoint-sor**, **tiltott zóna rajzolás**, réteg-kapcsolók, térkép-export |
| **Kézi irányítás** | Virtuális joystick, WASD, **gamepad**, testtartás/gait váltás, élő parancs-előzmény grafikon, és **kameraképek a vezérlés alatt**: bármelyik feed be/ki kapcsolható, a csempeszám adja az elrendezést (1 nagy · 2-3 egymás mellett · 4 rácsban) |
| **Kamerák** | 1×1 / 2×1 / 2×2 / 3×3 rács, hat feed (elülső, oldalsó, hátsó, éjjellátó, hő, **LiDAR nézet**), felvétel, pillanatkép, teljes nézet |
| **Szenzorok** | Fotó / LiDAR-scan / hőkép parancsok, felvétel-galéria szűréssel |
| **Küldetések** | **Vizuális lépéslánc-szerkesztő** (menj ide / API-hívás+várakozás / szenzor / hang / várakozás / MQTT / WebSocket), sablonok, futtatás, lépésenkénti élő követés |
| **Hang** | Hangkönyvtár teszt-lejátszással, esemény→hang szabálytábla, előzmény |
| **Feketedoboz** | Puffer-státusz, incidens-lista, **incidens-visszajátszó** idővonallal, csúszkával és képkockákkal |
| **Távoli elérés** | Tailscale-státusz, log-továbbítás, elérési címek |
| **Beállítások** | Mind a 60 paraméter egy helyen, kereséssel, profilokkal, exporttal |

## Paraméter-regiszter

A konzol központi ötlete: **minden hangolható érték egy helyen van deklarálva**
(`server/config.py`), metaadattal együtt (típus, tartomány, mértékegység, súgó,
biztonságkritikus-e). Az inspektorok és a Beállítások modul ebből **generálódnak** — új
paraméter felvétele egyetlen sor, frontend-módosítás nélkül.

Ez a közvetlen válasza a korábbi felület fő gyengeségére: a képességeknek voltak
paramétereik, de környezeti változókban laktak, ahol az operátor nem érte el őket.

Három beépített profil: **Beltéri lassú**, **Bemutató**, **Terepi** — egy kattintással
több csúszkát állítanak át.

## Térképezés: KISS-ICP tiszta LiDAR-odometria

Eddig az Élő 3D **egyetlen pásztázást** mutatott: egy pontfelhőt, ami másodpercenként
többször nulláról rajzolódott újra, és sosem lett belőle térkép. Nem a nézettel volt baj,
hanem azzal, hogy **nem volt pozíció**. A Go2 a `sportmodestate`-et csak sport módban
publikálja, tehát állva egyáltalán nincs pose — pozíció nélkül pedig két egymást követő
képkocka nem tehető közös koordinátarendszerbe.

A [KISS-ICP](https://github.com/PRBonn/kiss-icp) pontosan ezt a függést szünteti meg: a
6-DoF trajektóriát **magukból a pontfelhők geometriájából** számolja. Nem kell hozzá
lábodometria, IMU-integrálás vagy sport mód.

**Hol fut:** az operátori PC-n, szándékosan nem a dokkon. A Jetsonon nincs internet, tehát
a `kiss_icp` nem telepíthető rá; így viszont a robot oldalán semmi nem változik, a modul
kizárólag olvas.

```bash
pip install kiss-icp
```

**Kezelés az Élő 3D modulban:**

| | |
|---|---|
| `◌ SLAM: ÁLL` / `◉ SLAM: FUT` | a motor indítása és leállítása |
| `▦ Térkép` (3) | a halmozott térkép rétege — zöld, hogy elváljon az élő pásztázástól |
| `↝ Útvonal` (4) | a bejárt trajektória |
| `⟲ Térkép törlése` | az inspektorban: nulláról indítja a térképet és az odometriát |

A térképet **törölni kell**, ha a robotot felemelték vagy a kapcsolat hosszabban megszakadt:
a KISS-ICP nem tud visszatalálni egy ugrásból, amit nem látott, és egy ugráson átvarrt
térkép rosszabb, mint a semmi.

**Paraméterek** (Beállítások → Élő 3D → SLAM): illesztési voxel, min/max hatótáv, térkép
felbontása, feldolgozási ütem, mérethatár. Az alapértékek a rögzített sétákon
(`NERO_GO2/docker/mapping/walk_kicsi`, `walk_seta1`) mért legjobb beállítások.

**Végpontok:** `GET /api/slam` (állapot), `GET /api/slam/cloud` (a halmozott térkép),
`POST /api/slam/run`, `POST /api/slam/reset`. A `GET /api/map` a SLAM 2D vetületét adja,
ha nincs mapping-pillér.

A 2D vetület **csak mért adatból** készül: foglalt, ahol láttunk valamit; szabad, ahol a
padlót láttuk és felette semmit; minden más ismeretlen. Szabad területet sehol nem
találunk ki — a tervező így nem csalható rá olyan területre, amit sosem néztünk meg.

**Pozíció forrása.** A felület mindig kiírja, honnan jön a pozíció (`KISS-ICP (LiDAR)`
vagy `robot (sport mód)`). Ez nem kozmetika: egy ICP-pozíció sodródik, egy sportmode-pozíció
nem, és az operátornak tudnia kell, melyiket nézi.

**Sávszélesség.** Egy Hesai-képkocka JSON-ként 1,2 MB és 186 ms — ez kb. 2 Hz-re fogná a
SLAM-et. A hub `/lidar_bin/<forrás>` végpontja ugyanazt float32-ként adja: 216 kB, 23 ms.

## Biztonsági alapelvek a felületben

- Az **E-STOP** minden modulban látszik, és billentyűvel is kiadható.
- **Mozgásparancs megerősítéshez kötött** (térképre kattintás, waypoint-sor, küldetés
  indítása). A `sys.confirm_motion` kapcsolóval kikapcsolható — tudatos operátori döntésként.
- A kézi irányítás **folyamatos parancsáramot** küld, és a backend deadman-időzítővel áll meg,
  ha elengeded a kart vagy elveszik a fókusz.
- Ami nincs implementálva, az **`n/a`-ként jelenik meg**, nem hihető placeholder-értékként.

## Szerkezet

```
go2-console/
├── ANALYSIS.md          # helyzetelemzés, hiányelemzés, terv, fejlesztési ötletek
├── run.py               # indító
├── server/
│   ├── config.py        # paraméter-regiszter (67 paraméter + profilok)
│   ├── slam.py          # KISS-ICP odometria + halmozott 3D térkép (PC-oldalon)
│   ├── demo_backend.py  # szintetikus robot, térkép, kamerák, küldetések, feketedoboz
│   ├── live_backend.py  # adapter a valódi mission-control pillérekhez
│   └── app.py           # aggregáló API + WebSocket (backendet CONSOLE_BACKEND választ)
└── web/
    ├── index.html       # konzol-váz
    ├── css/console.css  # design-rendszer
    └── js/
        ├── core.js      # API-kliens, DOM-segédek, toast/modal, megosztott állapot
        ├── app.js       # váz, router, socket, generált inspektor
        └── modules/     # a tíz modul
```

## Kapcsolat a mission-control-lal

Ez a projekt **nem írja újra a backendet**. A `mission-control` adja a `core`
robot-absztrakciót (a 2026-09-10-i auditban bevezetett biztonsági réteggel: limitek,
watchdog, E-stop, token-auth), a log-odds térképezést, az A*-tervezőt, a task-motort és a
feketedoboz-logikát. Az éles mód ezekhez az API-khoz köt (`server/live_backend.py`),
ugyanazzal a felülettel, mint a demó.

## Következő lépések

1. ~~Éles adapter a `mission-control` pilléreihez~~ — kész (`server/live_backend.py`).
2. A `core` bővítése: gait/testtartás API, motorhőmérséklet és sebesség a `/state`-be
   (a `LowState` már szállítja őket, csak nincs kivezetve).
3. A tiltott zónák és a waypoint-sor átvezetése a tervezőbe és a vészfékbe.
4. Küldetés-idővonal visszajátszás a feketedoboz adataiból (ld. ANALYSIS 5.1).
5. Operátori műszaknapló (ki, mikor, mit adott ki) — enterprise követelmény.
6. Flotta-nézet a Pickerbot Mini bekapcsolásához.
7. Hurokzárás a SLAM-hez: a KISS-ICP tiszta odometria, nem ismeri fel, ha
   visszaérünk egy korábbi helyre, így hosszú bejáráson a sodródás megmarad.
8. Térkép mentése és visszatöltése (PLY/PCD), hogy egy bejárás ne vesszen el
   a konzol leállításakor.
