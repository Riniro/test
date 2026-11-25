# Orca multi-agent test

## Usage

```js
import { parseDuration, formatDuration } from './src/duration.js';

parseDuration("1h 30m") // 5400000
formatDuration(5400000) // "1h 30m"
formatDuration(0) // "0ms"
```

Run tests with `node --test`.
