"use client"

const Link = ({ href, children, className }: {
    href: string;
    children: React.ReactNode;
    className?: string;
}) => {
    const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
        e.preventDefault();
        window.history.pushState({}, '', href);
    };

    return (
        <a href={href} onClick={handleClick} className={className}>
            {children}
        </a>
    );
};

export default Link;
