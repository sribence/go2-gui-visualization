# Go2 Console — elemzés és tervezés

_2026-09-10 — side quest a `C:\dev\NERO_GO2\mission-control` mellett, külön mappában._

---

## 1. Mit csinálunk valójában?

Három különböző dolog keveredett eddig egy néven, és ez a fő oka annak, hogy a jelenlegi
felület nem elégíti ki az eredeti briefet:

| Réteg | Mi ez | Hol tart |
|---|---|---|
| **Robot-abstrakció** (`core`) | Egységes kliens a Go2 felé — póz, akku, IMU, kamera, LiDAR, mozgás | Kész, most már biztonságos is |
| **Képességek** (8 pillér) | Térképezés, navigáció, task-motor, szenzorok, multikamera, hang, feketedoboz, távoli elérés | Kész, de **API-only** |
| **Operátori felület** | Amiből egy ember ténylegesen üzemeltet | ❌ **Ez hiányzik** |

A `digital-twin` a harmadik réteg helyett egy **térkép-nézegetőt** ad. Szép, de a nyolc pillér
képességeinek nagyjából **15%-a** érhető el belőle. A többi funkció létezik, működik, van
végpontja — csak `curl`-lel hívható.

**Ez a projekt a hiányzó harmadik réteg.**

---

## 2. Mi volt a cél, és hol tartunk hozzá képest?

Az eredeti brief pontjai, és hogy mennyi látszik belőlük a jelenlegi felületen:

| # | Eredeti kérés | Backend | Felület | Hiányzik |
|---|---|:---:|:---:|---|
| 1 | Önálló térképezés bolyongással, **padló + fal** | ✅ | 🟡 | Indítás/leállítás gomb, haladásjelző, réteg-kapcsoló, felbontás/sebesség csúszkák |
| 2 | Térképre kattintva navigáció | ✅ | 🟡 | Waypoint-lista, útvonal-előnézet, tervező-paraméterek, megszakítás |
| 3 | Lépcsőn fel-le | 🟡 | ❌ | Lépcső-mód kapcsoló, sáv-csúszkák, gait-választó |
| 4 | WS / MQTT / REST más rendszerekkel, várakozó lánc | ✅ | ❌ | **Küldetésszerkesztő** — a legnagyobb hiány |
| 5 | Fotó / LiDAR / hőkamera parancs | ✅ | ❌ | Parancsgombok, felvétel-galéria |
| 6 | Esemény-vezérelt hang | ✅ | ❌ | Hangkönyvtár, esemény→hang szabályok, küszöb-csúszka, teszt-lejátszás |
| 7 | Tailscale távoli elérés | 🟡 | ❌ | Kapcsolat-státusz, log-küldés konfiguráció |
| 8 | Feketedoboz + automatikus törlés | ✅ | ❌ | Puffer-státusz, retenciós csúszkák, incidens-lista, visszajátszás |
| 9 | Több USB-kamera, éjjellátó, mentés | ✅ | ❌ | **Kamera-rács** — a második legnagyobb hiány |
| 10 | Unity-szerű 3D digitális iker | 🟡 | 🟡 | Relokalizáció, valós↔szimulált kapcsolat |
| 11 | Enterprise szintű parancskiadás a 3D nézetből | ❌ | ❌ | Az egész operátori munkafolyamat |
| — | **Kézi irányítás** (a briefben implicit) | ✅ | ❌ | Joystick, WASD, gamepad, sebesség-csúszkák, testtartás |

**Összegzés: a backend ~85%-ban kész, a felület ~15%-ban.** Nem új képességeket kell írni,
hanem **hozzáférést** adni a meglévőkhöz.

---

## 3. Miért lett "buta játék" a jelenlegi nézet?

Négy konkrét tervezési hiba, amit ez a projekt kijavít:

1. **Egyetlen nézet, nulla navigáció.** Nincs menü, nincs modul-fogalom. Egy operátori
   rendszernek 10-12 munkaterülete van; itt egy volt.
2. **Nincs beállítás sehol.** Minden paraméter (sebesség, robotsugár, retenció, közelségi
   küszöb, tick-idő) env-változó — a felhasználó nem fér hozzá. Pedig **minden funkciónak
   vannak hangolható paraméterei**, és az operátor pont ezeket akarja állítgatni.
3. **Mobil-first egy asztali feladathoz.** Az operátori munka FullHD-n, egérrel, több panel
   egyidejű figyelésével történik. A jelenlegi UI egy telefonra optimalizált egypaneles nézet.
4. **Csak olvasás, alig írás.** A felület gyakorlatilag egy dashboard. Egy konzolnak
   *parancsolnia* kell.

---

## 4. A Go2 Console terve

### 4.1 Elrendezés (1920×1080 alapra tervezve)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ GO2 CONSOLE   ●élő 12ms  ▓▓▓▓▓░ 68%  ⚠DISARMED  mód: MANUAL     ■ E-STOP    │ fejléc
├────┬────────────────────────────────────────────────────┬────────────────────┤
│ ⌂  │                                                    │  INSPEKTOR         │
│ 🗺  │                                                    │  (a modul saját    │
│ 🎮  │              MUNKATERÜLET                          │   beállításai,     │
│ 📷  │         (a kiválasztott modul)                     │   csúszkák,        │
│ 📡  │                                                    │   kapcsolók)       │
│ ✅  │                                                    │                    │
│ 🔊  │                                                    │                    │
│ ⬛  │                                                    │                    │
│ 🌐  │                                                    │                    │
│ ⚙  │                                                    │                    │
├────┴────────────────────────────────────────────────────┴────────────────────┤
│ ESEMÉNYNAPLÓ  12:04:21 nav útvonal tervezve (34 waypoint)   …    [szűrő] [×] │ lábléc
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Bal sáv:** modulválasztó, mindegyikhez állapot-pötty (pl. piros, ha az adott pillér nem elérhető).
- **Fejléc:** csak biztonságkritikus adat + E-STOP. Soha nem görgethető el.
- **Jobb inspektor:** a modul minden hangolható paramétere — ez az, ami eddig teljesen hiányzott.
- **Lábléc:** folyamatos eseménynapló, súlyosság szerint szűrhető.

### 4.2 Modulok és amit tudni fognak

| Modul | Munkaterület | Inspektor (állítható) |
|---|---|---|
| **Áttekintés** | Telemetria-kártyák, minitérkép, kamera-bélyegképek, aktív riasztások, gyorsparancsok | Frissítési gyakoriság, mely kártyák látszanak |
| **Térkép & Navigáció** | 2D/3D térkép, kattints-a-célra, waypoint-lista, útvonal, geofence-rajzoló | Robotsugár, haladási sebesség, kanyar-erősítés, waypoint-tűrés, lépcső-mód + sávok, felbontás, akadály-inflálás |
| **Kézi irányítás** | Virtuális joystick, WASD, gamepad-támogatás, testtartás-vezérlés, gait-választó | Max vx/vy/vyaw csúszkák, holtsáv, gyorsulás-korlát, deadman-időzítés |
| **Kamerák** | Multi-kamera rács (1/2×2/3×3), teljes képernyő, felvétel, pillanatkép | FPS, felbontás, JPEG-minőség, felvételi mappa, kamera-hozzárendelés (oldal/hátsó/éjjellátó/hő) |
| **Szenzorok** | Fotó / LiDAR-scan / hőkamera parancsgombok, felvétel-galéria | Scan-sűrűség, z-sávok, automatikus mentés, ütemezés |
| **Küldetések** | **Vizuális lépés-szerkesztő** (goto / API-hívás / szenzor / hang / várakozás / feltétel), futtatás, élő lépés-követés, WS/MQTT végpont-konfiguráció | Lépés-időkorlátok, újrapróbálkozás, párhuzamosság, MQTT topic-ok, engedélyezett API-hostok |
| **Hang** | Hangkönyvtár lejátszással, esemény→hang szabálytábla, feltöltés | Hangerő, cooldown, közelségi küszöb, mely eseményekre szóljon |
| **Feketedoboz** | Puffer-státusz, incidens-lista, incidens-visszajátszó idővonallal + képkockákkal | Retenciós idő, max méret, mintavételi gyakoriság, anomália-küszöbök (akku, IMU, hő) |
| **Távoli elérés** | Tailscale-státusz, tanúsítványok, log-küldés célpont | Küldési gyakoriság, mit küldjön, endpoint |
| **Beállítások** | Minden rendszerparaméter kategorizálva, profil mentés/betöltés | — |

### 4.3 Miért lesz ez más

- **Minden vezérlő valódi végpontra megy.** Nincs díszlet-gomb.
- **Minden csúszka mögött van egy tényleges paraméter**, ami eddig env-változóban lakott.
  A backend egy **paraméter-regisztert** exponál (`GET /api/settings`), amiből a felület
  automatikusan generálja a vezérlőket — így egy új paraméter felvétele egyetlen helyen történik.
- **Demó és éles ugyanaz a felület.** A demó-backend ugyanazt az API-t szolgálja ki
  szintetikus adattal, tehát a fejlesztés és a bemutató robot nélkül is megy.
- **A biztonság nem modul.** Az E-STOP a fejlécben van, minden modulban, mindig.

---

## 5. Amit én javaslok hozzá (a kért 5-10 ötlet)

1. **Küldetés-idővonal visszajátszása.** A feketedoboz adataiból egy scrubber: mozgasd az
   időt, és a térkép, a póz, a kameraképek és az eseménynapló együtt ugranak. Incidens-
   kivizsgálásnál ez a legértékesebb funkció, és az adat **már most keletkezik**.
2. **Paraméter-profilok.** „Beltéri lassú", „Bemutató", „Terepi" — egy kattintással váltható
   csúszka-készletek. Élő bemutatón felbecsülhetetlen.
3. **Virtuális kerítés és no-go zónák a térképen rajzolva**, a vészfékbe is bekötve, nem csak
   a tervezőbe — így a kézi irányítás sem viszi át rajta a robotot.
4. **„Mi változott?" térkép-diff.** Két bejárás összehasonlítása; őrjáratnál ez a tényleges
   üzleti érték (eltűnt/megjelent tárgy).
5. **Parancs-előnézet szimulációban.** Mielőtt egy küldetés élesben fut, játszd le a
   digitális ikren — útvonal, becsült idő, akkufogyás, ütközéskockázat.
6. **Operátori műszaknapló.** Minden parancs, ki adta ki, mikor, mi lett az eredménye —
   exportálható. Enterprise környezetben ez követelmény, nem extra.
7. **Kamera-alapú eseményjelölés.** Mozgásdetektálás a mentett feedben, és automatikus
   incidens-jelölés — így nem kell órákat visszanézni.
8. **Robot-egészség panel.** Motorhőmérsékletek, szervo-áramok, hibakódok trendje. A `LowState`
   ezt már szállítja, jelenleg senki nem használja fel.
9. **Flotta-nézet.** Több robot (Go2 + Pickerbot Mini) egy térképen, közös küldetéssorral.
10. **Offline térkép-export/import.** A bejárt térkép menthető, megosztható, újra betölthető —
    így nem kell minden indításkor újratérképezni.

---

## 6. Ami a `mission-control`-ból átjön

Ez a projekt **nem írja újra a backendet**. Átveszi:

- a `core` robot-absztrakciót és a most bevezetett biztonsági réteget (limit, watchdog, E-stop, auth),
- a `mapping_core` log-odds térképezést és frontier-exploration logikát,
- az `astar` tervezőt (a javított lépcső-kezeléssel),
- a `task_engine` lépés-motort,
- a `retention` feketedoboz-logikát,
- a map-sémát és az esemény-busz konvenciókat.

Amit hozzátesz: **a paraméter-regiszter**, **az aggregáló API** és **a teljes operátori felület**.
