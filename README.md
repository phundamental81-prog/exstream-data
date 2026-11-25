# exstream-data

Free streaming-service list for ExStream.

`services.json` says which streaming service (Netflix, HBO Max, Disney+, Prime Video, Apple TV+,
Hulu, Paramount+, Peacock, Crave, CBC Gem) each TV show comes from, and how popular it is right now,
so the ExStream player can show rows like "On Netflix" with the most popular shows first. It is
rebuilt every day by a GitHub Action (`build.mjs`) from:

- [Wikidata](https://www.wikidata.org) (CC0): a show's *original broadcaster* (P449), meaning the
  service that made or first aired it, or a TV channel the service owns whose shows stream on it
  (NBC for Peacock, ABC and FX for Hulu, CBS for Paramount+, CTV for Crave, CBC for CBC Gem...;
  channel shows from 2000 on)
- Wikimedia's free pageviews API: each show's English Wikipedia page views over the last 30 days

Format: `{"v": 3, "built": "YYYY-MM-DD", "services": [...], "shows": [[title, firstYear, serviceIndex, views30d], ...]}`

Nothing about any user, provider or app is stored here.
