# Obsidian-mahgen-plugin

This is a plugin for [mahgen](https://github.com/eric03742/mahgen) to render in [Obsidian](https://obsidian.md/)

The code is mostly implemented by LLMs, I don't know much about JavaScript. Any pull requests are appreciated.

# Build

```bash
npm i
npm run dev
```

I don't know how to publish yet.

# Usage

![usage](assets/image.png)

You can use `mg 1s2s3s`, or `mahgen 1112345678999m_0m`.
It can display the hand in between.
```mahgen
1234567z19s19p19m||||_1z
```

It can also display the river of tiles.
```mahgen-river
1234567z19s19p19m_1z
```

Displaying hand, draw, and discard.
```mahgen-river
123^456^7z^1^9s^1^9p1^9m_1z^1z
```

There is no river mode in inline, so it's unnecessary.

More details, please refer to [mahgen](https://github.com/eric03742/mahgen).