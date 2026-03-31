import { useCallback, useEffect, useState } from "react";

type Router = {
    path: string;
    push: (url: string) => void;
    replace: (url: string) => void;
    back: () => void;
    refresh: () => void;
};

const SSR_ROUTER: Router = { push: () => { }, replace: () => { }, back: () => { }, refresh: () => { }, path: "" };

export default function useRouter(): Router {
    if (typeof window === "undefined") {
        return SSR_ROUTER;
    }

    const [path, setPath] = useState(() => window.location.pathname);

    useEffect(() => {
        const handleLocationChange = () => setPath(window.location.pathname);
        window.addEventListener("locationchange", handleLocationChange);
        return () => window.removeEventListener("locationchange", handleLocationChange);
    }, []);

    const push = useCallback((url: string) => {
        window.history.pushState({}, "", url);
        setPath(url);
    }, []);

    const replace = useCallback((url: string) => {
        window.history.replaceState({}, "", url);
        setPath(url);
    }, []);

    const back = useCallback(() => {
        window.history.back();
    }, []);

    const refresh = useCallback(() => {
        window.dispatchEvent(new Event("locationchange"));
    }, []);

    return { path, push, replace, back, refresh };
}