"use client"
import useRouter from "./use-router"

const Link = ({ href, children, className }: {
    href: string;
    children: React.ReactNode;
    className?: string;
}) => {
    const r = useRouter()
    const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
        e.preventDefault();
        r.push(href);
    }
    return (
        <a href={href} onClick={handleClick} className={className} >
            {children}
        </a >
    );
};

export default Link;
