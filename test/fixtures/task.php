<?php
while (true) {
    echo file_get_contents("http://localhost/status");
    sleep(30);
}
