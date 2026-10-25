FROM nginx:1.27-alpine
COPY src/html /usr/share/nginx/html


#CMD ["nginx", "-g", "daemon off;"]