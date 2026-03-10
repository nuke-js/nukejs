import { useCallback, useEffect, useState } from "react";

type Router = {
    path: string;
    push: (url: string) => void;
    replace: (url: string) => void;
};

export default function useRouter(): Router {
    try {
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

        return { path, push, replace };
    } catch {
        return { push: () => {}, replace: () => {}, path: "" };
    }
}