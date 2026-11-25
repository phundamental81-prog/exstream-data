# exstream-data

Free streaming-service list for ExStream.

`services.json` says which streaming service (Netflix, HBO Max, Disney+, Prime Video, Apple TV+,
Hulu, Paramount+, Peacock, Crave, CBC Gem) each TV show comes from, so the ExStream player can show
rows like "On Netflix". It is rebuilt every day by a GitHub Action (`build.mjs`) from
[Wikidata](https://www.wikidata.org) (CC0): a show's *original broadcaster* (P449), meaning the
service that made or first aired it.

Format: `{"v": 2, "built": "YYYY-MM-DD", "services": [...], "shows": [[title, firstYear, serviceIndex], ...]}`

Nothing about any user, provider or app is stored here.
