"use client"

import { useState } from "react";

export default function Counter() {
    const [count, setCount] = useState(0)

    return (<><span>{count}</span><button onClick={() => setCount(count + 1)} style={{marginLeft: '5px'}}>+</button></>)
}