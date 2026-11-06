# Geographic levels and coverage

Normalize geographic scope with these roles while retaining each place's official native level name:

| Parent role | Default immediate children | Example title and coverage |
| --- | --- | --- |
| `world` | continents and major geographic regions | `地理图说·世界` → continents |
| `continent` | countries and territories under the chosen authoritative standard | `地理图说·亚洲` → each included country/territory |
| `country` | first-order divisions such as provinces, states, regions, or emirates | `地理图说·中国` → provincial-level divisions |
| `admin1` | prefectures, cities, departments, counties, or equivalent admin2 units | `地理图说·广东` → prefecture-level cities |
| `admin2` | counties, districts, county-level cities, boroughs, or equivalents | `地理图说·湛江` → county-level units |
| `admin3/locality` | townships, towns, subdistricts, communes, or equivalents | `地理图说·湛江市徐闻县` → towns/subdistricts |
| `township/subdistrict` | administrative villages and communities | `地理图说·徐闻县和安镇` → villages/communities |
| `village/community` | natural villages, settlement groups, streets, or meaningful landscape units | `地理图说·和安镇和安村` → settlements and local physical/human geography |
| `rural-area` | verified settlements, land use, waterways, roads, fields, heritage, and livelihoods | Use when “农村” is a narrative scope rather than a legal administrative level |

## Coverage rules

1. Resolve the authoritative child list and its effective date before scripting.
2. Write `coverage-manifest.json` with parent ID, normalized role, official level name, child IDs, child names, inclusion status, reason for any exclusion, and editorial order.
3. Treat “讲一遍所有下级” as complete immediate-child coverage. Do not silently sample representative children.
4. Complete coverage has three independent gates: boundary coverage, narration coverage, and camera/highlight coverage. Every included direct child must have at least one factual narration cue and one visible selected-state interval. Showing all names on one overview map does not count as introducing them.
5. Use an explicit classification policy for disputed areas, overseas territories, special regions, or inconsistent global administrative systems. State the policy in the external report without turning it into on-screen controversy.
6. Order children by a coherent geographic route, such as northwest-to-southeast, coast-to-interior, river basin, or neighboring chain. Do not sort filenames when an editorial route exists.
7. Split very large series into chapter masters while preserving one complete master index. For example, group Asian countries by subregion and Chinese provinces by geographic region, but keep every child represented once.
8. At village and rural scales, never invent formal boundaries, GDP, or population. Use verified cadastral/administrative data when available and otherwise distinguish settlement extent from legal boundary. If the source contains administrative-village polygons but the request names natural villages, state the mismatch and do not pretend the administrative polygons represent every natural settlement.

## Statutory units and functional areas

Before declaring complete coverage, classify every candidate as one of:

- statutory immediate child;
- functional new area, development zone, or management area;
- cooperation zone or enclave;
- editorial physical or cultural region.

Only statutory immediate children belong in the main complete-coverage manifest by default. Put functional areas in an explicitly named supplemental chapter unless the user asks for them as the primary organizing system. Do not present a new area or cooperation zone as a same-level legal district.

For example, a Shenzhen statutory district list and a Shenzhen functional-area list must remain separate; Dapeng New District and the Shenzhen-Shanwei Special Cooperation Zone cannot silently become additional statutory districts.

## Parent introduction

- Use the exact top title `地理图说·{hierarchicalTopicName}`. Include the immediate parent for township/subdistrict, county/district, village/community, and similarly ambiguous local topics; use the same text on the cover.
- Introduce the parent location, spatial extent, child count, physical framework, people, economy or livelihoods, history, culture, and route through its children.
- Reveal the parent boundary before child boundaries. After both have settled, keep the hierarchy stable until editorially necessary child selection begins.
