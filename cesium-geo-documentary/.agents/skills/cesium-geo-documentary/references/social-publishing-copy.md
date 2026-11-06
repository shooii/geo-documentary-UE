# Social publishing copy

Generate a release-ready work description for both Douyin and Kuaishou with every final video.

- Write separate `douyin` and `kuaishou` descriptions, each normally 42–60 visible characters and preferably close to 50.
- Name the complete hierarchical topic early. Include 2–4 verified, visually present local details rather than a broad list.
- Keep the tone conversational and concrete. Make the copy understandable without the video title.
- Preserve Arabic digits for distances, years, population, money, counts, and other concrete values.
- Do not use report language, tourism-advertising superlatives, GIS/production wording, source disclaimers, missing-boundary notes, or calls such as `点赞关注` unless the user requests them.
- Keep hashtags separate from the description. Recommend 2–5 precise tags, led by `#地理乡土情` and the exact locality.
- Do not introduce a place, product, school, event, or statistic that is absent from the verified research pack and final video.

Store the authored source at `content/publishing/{regionId}.json`. Run `pnpm geo-video publish-copy --region {regionId}` after final QA to export UTF-8 JSON and TXT files beside the final video.
